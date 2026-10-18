const express = require('express');
const cors = require('cors');
const { ApifyClient } = require('apify-client');
const sharp = require('sharp');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
app.use(cors()); // للسماح لموقعك بالاتصال بهذا الخادم
app.use(express.json());

// ⚠️ ملاحظة: المفاتيح ستُقرأ من إعدادات Render (Environment Variables)
const APIFY_TOKEN = process.env.APIFY_TOKEN || 'YOUR_APIFY_API_TOKEN';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'YOUR_OPENAI_API_KEY';

const apifyClient = new ApifyClient({ token: APIFY_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// دالة تحويل الألوان
function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : { r: 248, g: 249, b: 250 };
}

// دالة توليد الوصف من الصورة
async function generateDescriptionFromImage(imageUrl) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: "أنت خبير تسويق. اكتب وصفاً جذاباً بالعربية لهذا المنتج (افتتاحية، نقاط، دعوة لاتخاذ إجراء) بناءً على الصورة." },
                    { type: "image_url", image_url: { url: imageUrl } }
                ]
            }],
            temperature: 0.7,
            max_tokens: 500
        });
        return response.choices[0].message.content;
    } catch (error) {
        console.error('خطأ في الوصف:', error.message);
        return "لم يتم توليد وصف.";
    }
}

// دالة معالجة الصورة (قص، تحسين، ظل، خلفية)
async function processProductImage(imageUrl, hexColor) {
    try {
        // 1. إزالة الخلفية باستخدام Apify
        const run = await apifyClient.actor("vivid_astronaut/background-removal").call({
            imageUrl: imageUrl, outputFormat: "png", backgroundColor: "transparent"
        });
        const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
        if (!items || !items[0]?.result?.url) throw new Error('فشل إزالة الخلفية');

        // 2. تحميل الصورة الشفافة
        const response = await axios.get(items[0].result.url, { responseType: 'arraybuffer' });
        const cutoutBuffer = Buffer.from(response.data, 'binary');

        const CANVAS_SIZE = 1000;
        const PRODUCT_MAX_SIZE = Math.round(CANVAS_SIZE * 0.80);

        // 3. تحسين الجودة والمقاس
        const resizedProduct = await sharp(cutoutBuffer)
            .resize({ width: PRODUCT_MAX_SIZE, height: PRODUCT_MAX_SIZE, fit: 'inside' })
            .sharpen().modulate({ brightness: 1.03, saturation: 1.08 }).toBuffer();

        const metadata = await sharp(resizedProduct).metadata();
        const left = Math.floor((CANVAS_SIZE - metadata.width) / 2);
        const top = Math.floor((CANVAS_SIZE - metadata.height) / 2);

        // 4. إنشاء الظل الواقعي
        const rawShadow = await sharp(resizedProduct).ensureAlpha().linear(0, 0).blur(15).toBuffer();
        const shadowBuffer = await sharp(rawShadow).composite([{ input: Buffer.from([0, 0, 0, 64]), tile: true, blend: 'dest-in' }]).toBuffer();

        // 5. تركيب المنتج على الخلفية الجديدة
        const bgRgb = hexToRgb(hexColor);
        const finalBuffer = await sharp({
            create: { width: CANVAS_SIZE, height: CANVAS_SIZE, channels: 4, background: { ...bgRgb, alpha: 1 } }
        }).composite([
            { input: shadowBuffer, left: left, top: top + 25, blend: 'over' },
            { input: resizedProduct, left: left, top: top, blend: 'over' }
        ]).webp({ quality: 85 }).toBuffer();

        // تحويل الصورة إلى Base64 لكي نرسلها للموقع
        return `data:image/webp;base64,${finalBuffer.toString('base64')}`;
    } catch (error) {
        console.error('خطأ في معالجة الصورة:', error.message);
        throw error;
    }
}

// 🚀 الرابط (API Endpoint) الذي سيستقبل الطلبات من موقعك
app.post('/api/process-product', async (req, res) => {
    const { productName, variants } = req.body;

    if (!variants || !Array.isArray(variants)) {
        return res.status(400).json({ error: "الرجاء إرسال بيانات التنويعات (variants) بشكل صحيح." });
    }

    const results = [];
    for (const variant of variants) {
        try {
            // توليد الوصف ومعالجة الصورة
            const description = await generateDescriptionFromImage(variant.imageUrl);
            const processedImageBase64 = await processProductImage(variant.imageUrl, variant.hexColor || '#f8f9fa');
            
            results.push({
                variantName: variant.name,
                status: 'success',
                description: description,
                imageBase64: processedImageBase64 // الصورة جاهزة للإرسال للموقع
            });
            
            // تأخير بسيط لتجنب الحظر من الخدمات
            await new Promise(resolve => setTimeout(resolve, 1500)); 
        } catch (error) {
            results.push({ variantName: variant.name, status: 'failed', error: error.message });
        }
    }

    res.json({ productName, results });
});

// تشغيل الخادم
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 الخادم يعمل على المنفذ ${PORT}`);
});
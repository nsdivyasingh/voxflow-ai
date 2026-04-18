import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY;
const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`;

https.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    if(json.models) {
      json.models.filter(m => m.supportedGenerationMethods.includes('embedContent')).forEach(m => {
        console.log(`✅ Embedding model found: ${m.name}`);
      });
    } else {
      console.log('Error:', json);
    }
  });
});

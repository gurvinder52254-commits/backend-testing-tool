require('dotenv').config();
const fetch = require('node-fetch');

async function getModels() {
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    console.error('GROQ_API_KEY is not set. Add it to your .env file.');
    process.exit(1);
  }
  const response = await fetch('https://api.groq.com/openai/v1/models', {
    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` }
  });
  const data = await response.json();
  const llamaModels = data.data.filter(m => m.id.includes('llama') && m.active).map(m => m.id);
  console.log("Active Llama Models on Groq:");
  console.log(llamaModels.join('\n'));
}
getModels();

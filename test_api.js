async function testOllamaAPI() {
  const url = 'http://172.16.1.20:11435/v1/chat/completions';
  const model = 'qwen3.5:27b';
  
  const testCases = [
    { name: 'Root level think: false', body: { model, messages: [{ role: 'user', content: '1+1=' }], stream: false, think: false } },
    { name: 'Options level think: false', body: { model, messages: [{ role: 'user', content: '1+1=' }], stream: false, options: { think: false } } },
    { name: 'Include reasoning: false', body: { model, messages: [{ role: 'user', content: '1+1=' }], stream: false, include_reasoning: false } }
  ];

  for (const test of testCases) {
    console.log(`--- Testing: ${test.name} ---`);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(test.body)
      });
      const data = await response.json();
      const choice = data.choices[0];
      const hasReasoning = choice && choice.message && (choice.message.reasoning || choice.message.reasoning_content || (choice.message.content && choice.message.content.includes('<think>')));
      console.log('Reasoning detected:', !!hasReasoning);
      if (hasReasoning) {
          const r = choice.message.reasoning || choice.message.reasoning_content || choice.message.content;
          console.log('Reasoning sample:', r.substring(0, 50));
      }
      if (choice && choice.message) {
          console.log('Content:', choice.message.content.trim());
      } else {
          console.log('Full Response:', JSON.stringify(data));
      }
    } catch (error) {
      console.error('Error:', error.message);
    }
    console.log('\n');
  }
}

testOllamaAPI();

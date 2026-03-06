async function testNativeAPI() {
  const url = 'http://172.16.1.20:11435/api/chat';
  const model = 'qwen3.5:27b';
  
  console.log(`--- Testing Native API: think: false ---`);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: '1+1=' }],
        stream: false,
        think: false
      })
    });
    const data = await response.json();
    console.log('Thinking field exists:', !!data.thinking);
    if (data.thinking) {
        console.log('Thinking sample:', data.thinking.substring(0, 50));
    }
    console.log('Message content:', data.message.content.trim());
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testNativeAPI();

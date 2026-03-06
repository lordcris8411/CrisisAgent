async function checkModels() {
  try {
    const response = await fetch('http://10.0.0.20:11434/v1/models');
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    console.log('Available models:', JSON.stringify(data.data, null, 2));
  } catch (error) {
    console.error('Error checking models:', error.message);
  }
}
checkModels();

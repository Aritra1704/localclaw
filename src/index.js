// Entry point for the autonomous coder
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/health', (req, res) => {
  res.send('Autonomous Coder is running!');
});

app.listen(port, () => {
  console.log(`Autonomous Coder listening at http://localhost:${port}`);
});
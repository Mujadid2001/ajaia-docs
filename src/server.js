const { createApp } = require('./app');
const port = process.env.PORT || 3000;
createApp().listen(port, () => console.log(`Ajaia Docs running on http://localhost:${port}`));

const express = require('express');
const { join } = require('path');

const http = express();
http.set('etag', false);
http.set('x-powered-by', false);

http.use((req, res, next) => {
    console.log(`[${req.method}] ${req.originalUrl}`);
    next();
});
http.use(express.static(join(__dirname, './static'), { etag: false }));
http.use((req, res) => res.status(404).send(''));
http.listen(80, () => {
    console.log('[HTTP] Listening on port: ' + 80);
});
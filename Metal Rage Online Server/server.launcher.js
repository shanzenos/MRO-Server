const express = require('express');
const { join } = require('path');

const http = express();
http.set('etag', false);
http.set('x-powered-by', false);

http.use(express.urlencoded({ extended: true }));
http.use(express.json());

http.use((req, res, next) => {
    console.log(`[${req.method}] ${req.originalUrl}`);
    if (req.body && Object.keys(req.body).length > 0)
        console.log(`[BODY]`, req.body);
    next();
});

// 런처 로그인 요청 처리 - /s 경로로 들어오는 인증 요청 (handle launcher login request - authentication request via /s path)
http.post('/s', (req, res) => {
    console.log('[LOGIN] Launcher login request:', req.body);
    const username = req.body.id || req.body.username || req.body.user || 'Player';
    // 성공 응답 (실제 형식은 로그 확인 후 조정 필요) (success response — actual format needs to be adjusted after checking logs)
    res.send(`1\t${username}\t0\t0\t0`);
});

http.get('/s', (req, res) => {
    console.log('[LOGIN] Launcher GET /s:', req.query);
    const username = req.query.id || req.query.username || 'Player';
    res.send(`1\t${username}\t0\t0\t0`);
});

http.use(express.static(join(__dirname, './static'), { etag: false }));
http.use((req, res) => {
    console.log(`[404] ${req.method} ${req.originalUrl}`);
    res.status(404).send('');
});

http.listen(80, () => {
    console.log('[HTTP] Listening on port: ' + 80);
});
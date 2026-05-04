const express = require('express');
const { execSync } = require('child_process');
const { networkInterfaces } = require('os');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

let cachedHtml = null;

// ─── Ruta principal (Dinámica o estática) ───
app.get('/', (req, res, next) => {
    if (cachedHtml) {
        res.send(cachedHtml);
    } else {
        next(); // Pasa al express.static si no hay caché
    }
});

// ─── Servir archivos estáticos ───
app.use(express.static(process.cwd()));

// ─── Proxy para streaming (evita CORS) ───
app.get('/proxy', async (req, res) => {
    const url = req.query.url;

    if (!url) return res.status(400).send('Missing url parameter');

    try {
        const upstream = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': new URL(url).origin + '/',
                'Origin': new URL(url).origin
            },
            signal: AbortSignal.timeout(15000)
        });

        if (!upstream.ok) {
            return res.status(upstream.status).send(`Upstream error: ${upstream.status}`);
        }

        const contentType = upstream.headers.get('content-type') || '';

        // Si es un manifiesto m3u8, reescribir URLs relativas para que pasen por el proxy
        if (url.endsWith('.m3u8') || contentType.includes('mpegurl') || contentType.includes('x-mpegURL')) {
            let body = await upstream.text();
            const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);

            // Reescribir URLs relativas a absolutas via proxy
            body = body.replace(/^(?!#)(?!https?:\/\/)(.+\.ts.*)$/gm, (match) => {
                const absolute = match.startsWith('/') 
                    ? new URL(match, new URL(url).origin).href 
                    : baseUrl + match;
                return '/proxy?url=' + encodeURIComponent(absolute);
            });

            // Reescribir también playlists de variante (líneas que no empiezan con #)
            body = body.replace(/^(?!#)(?!https?:\/\/)(?!\/proxy)(.+\.m3u8.*)$/gm, (match) => {
                const absolute = match.startsWith('/')
                    ? new URL(match, new URL(url).origin).href
                    : baseUrl + match;
                return '/proxy?url=' + encodeURIComponent(absolute);
            });

            // Reescribir URLs absolutas (que NO pasan por proxy aún)
            body = body.replace(/^(https?:\/\/.+)$/gm, (match) => {
                if (match.includes('/proxy?')) return match; // ya proxied
                return '/proxy?url=' + encodeURIComponent(match);
            });

            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.set('Access-Control-Allow-Origin', '*');
            return res.send(body);
        }

        // Si es un manifiesto MPD — pasarlo sin modificar BaseURL
        // (Shaka usa el request filter para proxear las peticiones de segmentos)
        if (url.endsWith('.mpd') || contentType.includes('dash+xml')) {
            let body = await upstream.text();

            // Solo reescribir UTCTiming URLs si las hay (evita CORS en timing)
            body = body.replace(/value="(https?:\/\/[^"]+)"/gi, (match, timingUrl) => {
                return 'value="/proxy?url=' + encodeURIComponent(timingUrl) + '"';
            });

            res.set('Content-Type', 'application/dash+xml');
            res.set('Access-Control-Allow-Origin', '*');
            return res.send(body);
        }

        // Para segmentos binarios y otros archivos
        const buffer = Buffer.from(await upstream.arrayBuffer());
        if (contentType) res.set('Content-Type', contentType);
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Headers', '*');
        res.send(buffer);

    } catch (err) {
        console.error('Proxy error:', err.message);
        res.status(502).send('Proxy error: ' + err.message);
    }
});

// ─── CORS preflight ───
app.options('/proxy', (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', '*');
    res.sendStatus(204);
});

// ─── Endpoint para re-ejecutar el scraper ───
app.get('/scrape', async (req, res) => {
    try {
        console.log('Ejecutando scraper...');
        const { scrapeMatches } = require('./scraper.js');
        // Ejecuta el scraper sin escribir en disco (para Vercel)
        cachedHtml = await scrapeMatches(false); 
        console.log('Scraper completado');
        res.send(cachedHtml);
    } catch (err) {
        res.status(500).send('Error ejecutando scraper: ' + err.message);
    }
});

// ─── Iniciar servidor ───
if (process.env.NODE_ENV !== 'production' && require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        const localIp = getLocalIp();
        console.log('\n⚽ Fútbol Libre Server\n');
        console.log(`  Local:   http://localhost:${PORT}`);
        if (localIp) {
            console.log(`  Red:     http://${localIp}:${PORT}`);
            console.log(`  Móvil:   Abre esa URL en tu teléfono (misma WiFi)`);
        }
        console.log(`\n  /scrape  → Actualizar agenda`);
        console.log(`  /proxy   → Proxy de streams\n`);
    });
}

function getLocalIp() {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) return net.address;
        }
    }
    return null;
}

module.exports = app;

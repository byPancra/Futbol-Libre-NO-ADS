const express = require('express');
const { Readable } = require('stream');
const { networkInterfaces } = require('os');
const path = require('path');
const { scrapeMatches } = require('./scraper.js');

const app = express();
app.set('trust proxy', 1);
const PORT = 3000;

let cachedHtml = null;
let lastScrapeTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// ─── Ruta principal: Landing Page ───
app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'landing.html'));
});

// ─── Endpoint de descarga: genera y devuelve index.html standalone ───
app.get('/download', async (req, res) => {
    try {
        const now = Date.now();
        let html;

        if (cachedHtml && (now - lastScrapeTime < CACHE_TTL)) {
            html = cachedHtml;
        } else {
            console.log('Generando agenda para descarga...');
            html = await scrapeMatches(false);
            cachedHtml = html;
            lastScrapeTime = Date.now();
        }

        const serverOrigin = `${req.protocol}://${req.get('host')}`;
        // Inyectamos la URL base del servidor en el HTML descargado
        let finalHtml = html.replace('<head>', `<head>\n    <script>window.PROXY_HOST = "${serverOrigin}";</script>`);

        res.set('Content-Type', 'text/html; charset=utf-8');
        res.set('Content-Disposition', 'attachment; filename="futbol libre sin publicidad.html"');
        res.send(finalHtml);
    } catch (err) {
        console.error('Error generando descarga:', err.message);
        res.status(500).send('Error generando la agenda: ' + err.message);
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
            res.set('Access-Control-Allow-Origin', '*');
            res.set('Access-Control-Allow-Headers', '*');
            return res.status(upstream.status).send(`Upstream error: ${upstream.status}`);
        }

        const contentType = upstream.headers.get('content-type') || '';

        // Si es un manifiesto m3u8, reescribir URLs relativas para que pasen por el proxy
        if (url.endsWith('.m3u8') || contentType.includes('mpegurl') || contentType.includes('x-mpegURL')) {
            let body = await upstream.text();
            const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
            const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;

            // Reescribir URLs relativas a absolutas via proxy
            body = body.replace(/^(?!#)(?!https?:\/\/)(.+\.ts.*)$/gm, (match) => {
                const absolute = match.startsWith('/') 
                    ? new URL(match, new URL(url).origin).href 
                    : baseUrl + match;
                return proxyBase + encodeURIComponent(absolute);
            });

            // Reescribir también playlists de variante (líneas que no empiezan con #)
            body = body.replace(/^(?!#)(?!https?:\/\/)(?!\/proxy)(.+\.m3u8.*)$/gm, (match) => {
                const absolute = match.startsWith('/')
                    ? new URL(match, new URL(url).origin).href
                    : baseUrl + match;
                return proxyBase + encodeURIComponent(absolute);
            });

            // Reescribir URLs absolutas (que NO pasan por proxy aún)
            body = body.replace(/^(https?:\/\/.+)$/gm, (match) => {
                if (match.includes('/proxy?')) return match; // ya proxied
                return proxyBase + encodeURIComponent(match);
            });

            // Reescribir también URIs de encryption keys (#EXT-X-KEY:...URI="...")
            body = body.replace(/(#EXT-X-KEY:[^\n]*URI=")((?!\/?proxy\?)[^"]+)(")/gm, (match, prefix, uri, suffix) => {
                if (uri.includes('/proxy?') || uri.startsWith('data:')) return match;
                const absolute = uri.startsWith('http') ? uri
                    : uri.startsWith('/') ? new URL(uri, new URL(url).origin).href
                    : baseUrl + uri;
                return prefix + proxyBase + encodeURIComponent(absolute) + suffix;
            });

            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.set('Access-Control-Allow-Origin', '*');
            return res.send(body);
        }

        // Si es un manifiesto MPD — pasarlo sin modificar BaseURL
        // (Shaka usa el request filter para proxear las peticiones de segmentos)
        if (url.endsWith('.mpd') || contentType.includes('dash+xml')) {
            let body = await upstream.text();
            const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;

            // Solo reescribir UTCTiming URLs si las hay (evita CORS en timing)
            body = body.replace(/value="(https?:\/\/[^"]+)"/gi, (match, timingUrl) => {
                return 'value="' + proxyBase + encodeURIComponent(timingUrl) + '"';
            });

            res.set('Content-Type', 'application/dash+xml');
            res.set('Access-Control-Allow-Origin', '*');
            return res.send(body);
        }

        // Para segmentos binarios y otros archivos
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Headers', '*');
        if (contentType) res.set('Content-Type', contentType);
        
        // Optimización: Usar stream piping
        const nodeStream = Readable.fromWeb(upstream.body);
        nodeStream.pipe(res);
        nodeStream.on('error', () => res.end());

    } catch (err) {
        console.error('Proxy error:', err.message);
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Headers', '*');
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

// ─── Endpoint para resolver stream lazy ───
app.get('/resolve', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.json(null);
    try {
        const { getStreamUrl } = require('./scraper.js');
        const result = await getStreamUrl(url);
        res.json(result || null);
    } catch {
        res.json(null);
    }
});

// ─── Endpoint para re-ejecutar el scraper (legacy) ───
app.get('/scrape', async (req, res) => {
    try {
        console.log('Actualización manual forzada...');
        cachedHtml = await scrapeMatches(false); 
        lastScrapeTime = Date.now();
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
        console.log(`\n  /           → Landing page`);
        console.log(`  /download   → Descargar agenda HTML`);
        console.log(`  /proxy      → Proxy de streams\n`);
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

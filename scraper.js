const fs = require('fs');
const cheerio = require('cheerio');

const CONCURRENCY = 15; // Aumentado para procesar más rápido

// ─── Resolver la URL de streaming + claves DRM ───
// Devuelve { url, k1?, k2? } o null
async function getStreamUrl(targetUrl) {
    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
                'Referer': 'https://pelotalibretv.su/'
            },
            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) return null;
        const html = await response.text();

        // 1) var playbackURL = "..." (latamvidz1.com) — HLS sin DRM
        const playbackMatch = html.match(/var\s+playbackURL\s*=\s*['"]([^'"]+)['"]/);
        if (playbackMatch) return { url: playbackMatch[1] };

        // 2) source: "...m3u8..." — HLS directo
        const sourceMatch = html.match(/source:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/);
        if (sourceMatch) return { url: sourceMatch[1] };

        // 3) ConfiguracionCanales (esvideofy.com) — DASH con clearkey DRM
        if (targetUrl.includes('id=')) {
            const idMatch = targetUrl.match(/id=([^&]+)/);
            if (idMatch) {
                const id = idMatch[1];
                const idEsc = escapeRegex(id);
                
                // Extraer url
                const urlRegex = new RegExp('"' + idEsc + '"\\s*:\\s*\\{[^}]*url\\s*:\\s*["\']([^"\']+)["\']');
                const urlMatch = html.match(urlRegex);
                if (!urlMatch) return null;

                // Extraer k1 y k2 (claves DRM clearkey)
                const blockRegex = new RegExp('"' + idEsc + '"\\s*:\\s*\\{([^}]+)\\}');
                const blockMatch = html.match(blockRegex);
                
                let k1 = null, k2 = null;
                if (blockMatch) {
                    const k1Match = blockMatch[1].match(/k1\s*:\s*["']([^"']+)['"]/);
                    const k2Match = blockMatch[1].match(/k2\s*:\s*["']([^"']+)['"]/);
                    if (k1Match) k1 = k1Match[1];
                    if (k2Match) k2 = k2Match[1];
                }

                return { url: urlMatch[1], k1, k2 };
            }
        }

        return null;
    } catch {
        return null;
    }
}

// ─── Decodificar el parámetro base64 de la URL ───
function decodeStreamUrl(href) {
    if (!href || !href.includes('?r=')) return null;
    const rMatch = href.match(/r=([^&]+)/);
    if (!rMatch) return null;
    try {
        return Buffer.from(decodeURIComponent(rMatch[1]), 'base64').toString('utf-8');
    } catch {
        return null;
    }
}

// ─── Scraping principal ───
async function scrapeMatches(writeToDisk = true) {
    const startTime = Date.now();
    console.log('Scraping agenda de pelotalibretv.su...\n');

    const res = await fetch('https://pelotalibretv.su/agenda/', {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
            'Accept-Language': 'es-ES,es;q=0.9'
        }
    });

    if (!res.ok) throw new Error(`Error al acceder a la agenda: HTTP ${res.status}`);

    const html = await res.text();
    const $ = cheerio.load(html);
    const agendaTitle = $('.sombreada_css3').text().trim() || 'Agenda Deportiva';

    // ─── 1. Extraer datos de los partidos ───
    const matches = [];

    $('.menu > li').each((_, el) => {
        const $li = $(el);
        const countryClass = ($li.attr('class') || '').trim();
        const aTag = $li.children('a').first();
        const time = aTag.find('span.t').text().trim();
        const matchName = aTag.text().replace(time, '').trim();

        const options = [];
        $li.find('ul li a').each((_, optEl) => {
            const $opt = $(optEl);
            const quality = $opt.find('span').text().trim();
            const channel = $opt.text().replace(quality, '').trim();
            let href = $opt.attr('href') || '';
            if (href.startsWith('/')) href = 'https://pelotalibretv.su' + href;
            options.push({ channel, quality, href, stream: null });
        });

        if (matchName) {
            matches.push({ countryClass, time, matchName, options });
        }
    });

    console.log(`Se encontraron ${matches.length} partidos. Resolviendo URLs...\n`);

    // ─── 2. Resolver URLs (concurrencia global) ───
    let resolved = 0, failed = 0;
    const allTasks = [];

    // Recopilar todas las opciones válidas
    const optionsToResolve = [];
    for (const match of matches) {
        for (const opt of match.options) {
            const decoded = decodeStreamUrl(opt.href);
            if (decoded) optionsToResolve.push({ opt, decoded, matchName: match.matchName });
        }
    }

    // Procesar en lotes globales
    for (let i = 0; i < optionsToResolve.length; i += CONCURRENCY) {
        const batch = optionsToResolve.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (item) => {
            try {
                const result = await getStreamUrl(item.decoded);
                item.opt.stream = result;
                if (result) {
                    resolved++;
                } else {
                    failed++;
                }
            } catch (err) {
                failed++;
            }
        }));
    }

    console.log(`\nResueltos: ${resolved} | Fallidos: ${failed}\n`);

    // ─── 3. Generar partidos.txt ───
    let txt = '';
    for (const match of matches) {
        txt += `[${match.time}] ${match.matchName}\n`;
        if (match.options.length === 0) txt += '  - Sin opciones de streaming\n';
        for (const opt of match.options) {
            const url = opt.stream ? opt.stream.url : 'No se pudo obtener el link';
            txt += `  - ${opt.channel} -> ${url}\n`;
        }
        txt += '\n';
    }

    // ─── 4. Generar index.html ───
    const htmlOutput = buildHtml(agendaTitle, matches);

    if (writeToDisk) {
        fs.writeFileSync('partidos.txt', txt, 'utf-8');
        fs.writeFileSync('index.html', htmlOutput, 'utf-8');
        console.log(`✅ partidos.txt generado`);
        console.log(`✅ index.html generado`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`⏱  Tiempo total: ${elapsed}s`);
    
    return htmlOutput;
}

// ─── Generar el HTML con reproductor integrado ───
function buildHtml(title, matches) {
    let matchesHtml = '';
    let streamIndex = 0;
    const streamData = []; // Para inyectar como JSON en el HTML

    for (const match of matches) {
        const resolvedOptions = match.options.filter(o => o.stream);

        let optionsHtml = '';
        for (const opt of resolvedOptions) {
            const idx = streamIndex++;
            streamData.push({
                url: opt.stream.url,
                k1: opt.stream.k1 || null,
                k2: opt.stream.k2 || null
            });
            optionsHtml += `<li class="subitem1"><a href="#" onclick="playStream(${idx});return false;">${esc(opt.channel)}<span>${esc(opt.quality)}</span></a></li>\n`;
        }

        matchesHtml += `
<li class="${esc(match.countryClass)}"><a href="#">
${esc(match.matchName)}<span class="t">${esc(match.time)}</span></a>
<ul>
${optionsHtml}</ul>
</li>
`;
    }

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font-size:100%;background:#fff;margin:0}
@media only screen and (max-width:600px){body{font-size:70%}}
a{text-decoration:none}
ul,ul ul{margin:0;padding:0;list-style:none}
#wraper{width:100%;margin:0 auto;font-size:.8125em}
.menu{width:auto;height:auto;box-shadow:0 1px 3px 0 rgba(0,0,0,.73),0 0 18px 0 rgba(0,0,0,.1)}
.menu>li>a{background:#fff;border-bottom:0 solid #33373d;box-shadow:inset 0 1px 0 0 #878e98;width:100%;height:2.8em;line-height:2.8em;text-indent:7.9em;display:block;position:relative;font-family:Arial,Helvetica,sans-serif;font-weight:600;color:#404040;font-size:1em}
.menu ul li a{background:#fff;border-bottom:1px solid #efeff0;width:100%;height:2.8em;line-height:2.8em;text-indent:3.75em;display:block;position:relative;font-family:Arial,Helvetica,sans-serif;font-size:1em;font-weight:500;color:#789;cursor:pointer}
.menu ul li:last-child a{border-bottom:1px solid #33373d}
.menu>li>a:hover,.menu>li>a.active{background:rgb(148,204,124);border-bottom:1px solid #404040;box-shadow:inset 0 1px 0 0 #404040}
.menu>li>a.active{border-bottom:0 solid #404040}
.menu>li>a:before{content:'';background-image:url(https://pelotalibretv.su/agenda/spriteupdate8.png);background-repeat:no-repeat;font-size:36px;height:1em;width:1em;position:absolute;left:55px;top:50%;margin:-.5em 0 0}
@media only screen and (max-width:600px){.menu>li>a:before{left:30px}}
.LC>a:before{background-position:-75px -720px}.VEN>a:before{background-position:-38px -725px}.COL>a:before{background-position:0 0}.MEX>a:before{background-position:-38px 0}.ES>a:before{background-position:0 -38px}.PE>a:before{background-position:-38px -38px}.CAT>a:before{background-position:0 -685px}.ENG>a:before{background-position:-76px 0}.FRA>a:before{background-position:-76px -38px}.USA>a:before{background-position:0 -76px}.JA>a:before{background-position:-38px -76px}.IT>a:before{background-position:0 -114px}.BRA>a:before{background-position:-38px -114px}.ALE>a:before{background-position:-76px -76px}.POR>a:before{background-position:-76px -114px}.CH>a:before{background-position:0 -152px}.ECUA>a:before{background-position:-38px -152px}.URU>a:before{background-position:0 -190px}.EURO>a:before{background-position:-38px -190px}.AR>a:before{background-position:-76px -152px}.AMERICA>a:before{background-position:-76px -190px}.ARA>a:before{background-position:-37px -687px}.PAR>a:before{background-position:0 -608px}.BOL>a:before{background-position:-76px -608px}.PARA>a:before{background-position:0 -646px}.HOL>a:before{background-position:-38px -608px}
.menu>li>a span{font-size:.95em;display:inline-block;position:absolute;left:.3em;top:50%;background:#fff;line-height:1em;height:1em;padding:.3em .6em;margin:-.8em 0 0;color:#222d36;text-indent:0;text-align:center;border-radius:.569em;box-shadow:inset 0 1px 3px 0 rgba(0,0,0,.16),0 1px 0 0 rgba(63,68,74,.1);font-weight:500}
.menu>li>a:hover span,.menu>li a.active span{background:#404040;color:#fff}
.menu>li>ul li a:before{content:'►';font-size:9px;color:#789;position:absolute;width:1em;height:1em;top:0;left:-2.7em}
.menu>li>ul li:hover a,.menu>li>ul li:hover a span,.menu>li>ul li:hover a:before{color:#2e9afe}
.menu ul>li>a span{font-size:.857em;display:inline-block;position:absolute;right:1em;top:50%;border:1px solid #d0d0d3;line-height:1em;height:1em;padding:.4em .7em;margin:-.9em 0 0;color:#000;text-indent:0;text-align:center;border-radius:.769em}
div.sombreada_css3{background-color:#57B230;width:100%;padding:12px;color:#002399;box-shadow:0 1px 1px #333;text-align:center;box-sizing:border-box}

/* ─── Player Overlay ─── */
#player-overlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.92);z-index:9999;justify-content:center;align-items:center;flex-direction:column}
#player-overlay.active{display:flex}
#player-overlay video{width:90%;max-width:1200px;max-height:80vh;background:#000;border-radius:8px}
#player-close{position:fixed;top:15px;right:25px;font-size:36px;color:#fff;cursor:pointer;z-index:10000;font-family:Arial;line-height:1}
#player-close:hover{color:#ff4444}
#player-status{color:#aaa;font-family:Arial;font-size:14px;margin-top:10px}
#btn-refresh{display:inline-block;background:#2e9afe;color:#fff;border:none;padding:6px 18px;border-radius:4px;cursor:pointer;font-size:12px;font-family:Arial;margin-left:12px;vertical-align:middle}
#btn-refresh:hover{background:#0d7edb}
</style>
<script src="https://ajax.googleapis.com/ajax/libs/jquery/1.7.1/jquery.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<script src="https://cdn.jsdelivr.net/npm/shaka-player@4/dist/shaka-player.compiled.js"></script>
<script>
// Auto-actualizar al abrir la web (Redirigir a /scrape si estamos en la raíz)
if (window.location.pathname === '/' || window.location.pathname === '/index.html') {
    window.location.replace('/scrape');
}
</script>
</head>
<body>

<!-- Player Overlay -->
<div id="player-overlay">
    <span id="player-close" onclick="closePlayer()">&times;</span>
    <video id="player-video" controls autoplay playsinline webkit-playsinline></video>
    <div id="player-status"></div>
</div>

<div id="wraper">
<ul class="menu">
<center>
<div class="sombreada_css3">
<font size="2" face="Helvetica Neue,Helvetica,Arial,sans-serif" color="#FFFFFF">
<b>${esc(title)}</b>
<a id="btn-refresh" href="/scrape">🔄 Actualizar</a>
</font>
</div>
</center>

${matchesHtml}

</ul>
</div>

<script>
// Datos de streams inyectados por el scraper
var STREAMS = ${JSON.stringify(streamData)};

var currentHls = null;
var currentShaka = null;

// Helper: URL a través del proxy
function proxyUrl(url) {
    return '/proxy?url=' + encodeURIComponent(url);
}

function playStream(idx) {
    var s = STREAMS[idx];
    if (!s) return;
    
    var video = document.getElementById('player-video');
    var overlay = document.getElementById('player-overlay');
    var status = document.getElementById('player-status');
    
    // Limpiar reproductor anterior
    closePlayerInternal();
    
    overlay.className = 'active';
    status.textContent = 'Cargando stream...';
    
    var url = s.url;
    
    if (url.indexOf('.m3u8') !== -1) {
        // ─── HLS via proxy ───
        if (Hls.isSupported()) {
            currentHls = new Hls({
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                liveSyncDurationCount: 3,
                xhrSetup: function(xhr, xhrUrl) {
                    // Si la URL ya pasa por el proxy, no la modificamos
                    if (xhrUrl.indexOf('/proxy?') !== -1) return;
                    // Si es una URL absoluta, la enviamos por el proxy
                    if (xhrUrl.indexOf('http') === 0) {
                        xhr.open('GET', proxyUrl(xhrUrl), true);
                    }
                }
            });
            // Cargar el m3u8 a través del proxy (el proxy reescribe las URLs internas)
            currentHls.loadSource(proxyUrl(url));
            currentHls.attachMedia(video);
            currentHls.on(Hls.Events.MANIFEST_PARSED, function() {
                status.textContent = 'HLS ▶ Reproduciendo';
                video.play().catch(function(){});
            });
            currentHls.on(Hls.Events.ERROR, function(ev, data) {
                console.error('HLS Error:', data);
                if (data.fatal) {
                    status.textContent = 'Error HLS: ' + data.type + ' - ' + data.details;
                    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                        status.textContent += ' (Reintentando...)';
                        setTimeout(function() { currentHls && currentHls.startLoad(); }, 3000);
                    }
                }
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari nativo: usa el proxy para reescribir URLs internas
            video.src = proxyUrl(url);
            video.addEventListener('loadedmetadata', function() {
                status.textContent = 'HLS nativo ▶ Reproduciendo';
                video.play().catch(function(){});
            });
            video.addEventListener('error', function() {
                status.textContent = 'Error: No se pudo cargar el stream';
            });
        }
    } else if (url.indexOf('.mpd') !== -1) {
        // ─── DASH via proxy (con clearkey DRM si hay k1/k2) ───
        shaka.polyfill.installAll();
        var player = new shaka.Player(video);
        currentShaka = player;
        
        // Base URL original del MPD (para resolver URLs relativas)
        var mpdBase = url.substring(0, url.lastIndexOf('/') + 1);
        
        // Filtro de red: todas las peticiones pasan por el proxy
        player.getNetworkingEngine().registerRequestFilter(function(type, request) {
            if (request.uris && request.uris.length > 0) {
                for (var i = 0; i < request.uris.length; i++) {
                    var uri = request.uris[i];
                    // Ya pasa por el proxy
                    if (uri.indexOf('/proxy?') !== -1) continue;
                    
                    if (uri.indexOf('http') === 0) {
                        // Detectar URLs que Shaka resolvió contra localhost
                        // (ej: http://localhost:3000/dash/20465730-video=1000000.dash)
                        try {
                            var parsed = new URL(uri);
                            if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
                                // Reconstruir la URL real usando la base del MPD original
                                var segment = parsed.pathname;
                                if (segment.startsWith('/')) segment = segment.substring(1);
                                // Remover el prefijo /proxy?url=... si se coló
                                if (segment.startsWith('proxy?url=')) {
                                    request.uris[i] = '/proxy?url=' + segment.substring(10);
                                    continue;
                                }
                                var realUrl = mpdBase + segment;
                                request.uris[i] = proxyUrl(realUrl);
                            } else {
                                // URL absoluta real (no localhost)
                                request.uris[i] = proxyUrl(uri);
                            }
                        } catch(e) {
                            request.uris[i] = proxyUrl(uri);
                        }
                    }
                }
            }
        });
        
        // Listener de errores para debug
        player.addEventListener('error', function(event) {
            console.error('Shaka error event:', event.detail);
        });
        
        if (s.k1 && s.k2) {
            player.configure({
                drm: {
                    clearKeys: keyPairToClearKey(s.k1, s.k2),
                    // Forzar SOLO ClearKey, ignorar Widevine/PlayReady del MPD
                    servers: {},
                    advanced: {}
                },
                streaming: {
                    lowLatencyMode: false,
                    autoLowLatencyMode: false
                }
            });
        }
        
        // Cargar el MPD a través del proxy
        player.load(proxyUrl(url)).then(function() {
            status.textContent = 'DASH' + (s.k1 ? ' (DRM ClearKey)' : '') + ' ▶ Reproduciendo';
            video.play().catch(function(){});
        }).catch(function(err) {
            console.error('Shaka error:', err);
            var code = err.code || '';
            var msg = 'Error DASH: ';
            if (code === 6002) {
                msg += 'No se pudo inicializar DRM. Asegúrate de usar localhost o HTTPS.';
            } else if (code === 1002) {
                msg += 'Error de red. El stream podría no estar disponible.';
            } else {
                msg += err.message || ('Código ' + code);
            }
            status.textContent = msg;
        });
    } else {
        // Intentar reproducción directa via proxy
        video.src = proxyUrl(url);
        video.play().catch(function(){});
        status.textContent = 'Reproduciendo directo';
    }
}

// Convertir k1(hex keyId) y k2(hex key) al formato que Shaka espera
function keyPairToClearKey(kid, key) {
    var obj = {};
    obj[kid] = key;
    return obj;
}

function closePlayer() {
    closePlayerInternal();
    document.getElementById('player-overlay').className = '';
}

function closePlayerInternal() {
    var video = document.getElementById('player-video');
    if (currentHls) { currentHls.destroy(); currentHls = null; }
    if (currentShaka) {
        currentShaka.destroy().catch(function(){});
        currentShaka = null;
    }
    video.removeAttribute('src');
    video.load();
}

// Cerrar con Escape
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closePlayer();
});

// Cerrar al hacer clic fuera del video
document.getElementById('player-overlay').addEventListener('click', function(e) {
    if (e.target === this) closePlayer();
});

// ─── Menú acordeón ───
$(function() {
    var menu_ul = $('.menu > li > ul'),
        menu_a  = $('.menu > li > a');
    menu_ul.hide();
    menu_a.click(function(e) {
        e.preventDefault();
        if (!$(this).hasClass('active')) {
            menu_a.removeClass('active');
            menu_ul.filter(':visible').slideUp('fast');
            $(this).addClass('active').next().stop(true,true).slideDown('fast');
        } else {
            $(this).removeClass('active');
            $(this).next().stop(true,true).slideUp('fast');
        }
    });
});
// ─── Ajuste automático de Zona Horaria ───
// Convierte la hora base (UTC+1) a la hora local del usuario
$(function() {
    var offsetMin = (new Date().getTimezoneOffset() * -1) - 60; 
    if (offsetMin !== 0) {
        $('span.t').each(function() {
            var text = $(this).text().trim();
            if (text) {
                var parts = text.split(':');
                if (parts.length === 2) {
                    var d = new Date();
                    d.setHours(parseInt(parts[0], 10));
                    d.setMinutes(parseInt(parts[1], 10) + offsetMin);
                    
                    var h = d.getHours().toString().padStart(2, '0');
                    var m = d.getMinutes().toString().padStart(2, '0');
                    $(this).text(h + ':' + m);
                }
            }
        });
    }
});

</script>

</body>
</html>`;
}

// ─── Utilidades ───
function esc(str) {
    return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

if (require.main === module) {
    scrapeMatches(true).catch(err => console.error('Error fatal:', err));
}

module.exports = { scrapeMatches };

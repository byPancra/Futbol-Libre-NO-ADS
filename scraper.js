const fs = require('fs');
const cheerio = require('cheerio');

// Desactivar verificación TLS para servidores de streaming con cert self-signed
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const CONCURRENCY = 15; // Aumentado para procesar más rápido

// ─── Resolver la URL de streaming + claves DRM ───
// Devuelve { url, k1?, k2? } o null
async function getStreamUrl(targetUrl, refererOrigin) {
    try {
        const referer = refererOrigin || 'https://pelotalibretv.su/';
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
                'Referer': referer
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

        // 3) JWPlayer format: "file": 'url', "drm": { "clearkey": { "keyId": "...", "key": "..." } }
        const jwFileMatch = html.match(/["']file["']\s*:\s*['"]([^'"]+\.mpd[^'"]*)['"]/);
        if (jwFileMatch) {
            let k1 = null, k2 = null;
            const keyIdMatch = html.match(/["']keyId["']\s*:\s*['"]([^'"]+)['"]/);
            const keyMatch = html.match(/["']key["']\s*:\s*['"]([^'"]+)['"]/);
            if (keyIdMatch && keyMatch) {
                k1 = keyIdMatch[1];
                k2 = keyMatch[1];
            }
            return { url: jwFileMatch[1], k1, k2 };
        }

        // 4) canais/ConfiguracionCanales object — { id: { url: "...", clearkey: { k: v } } }
        if (targetUrl.includes('id=')) {
            const idMatch = targetUrl.match(/id=([^&]+)/);
            if (idMatch) {
                const id = idMatch[1];
                const idEsc = escapeRegex(id);
                
                // Buscar el bloque del canal (con o sin comillas en la key)
                // Formato: id: { url: "...", clearkey: { 'k1': 'k2' } }
                const blockRegex = new RegExp('["\']?' + idEsc + '["\']?\\s*:\\s*\\{([\\s\\S]*?\\})\\s*[,}]', 'i');
                const blockMatch = html.match(blockRegex);
                if (!blockMatch) return null;
                
                const block = blockMatch[1];
                
                // Extraer URL del bloque
                const urlMatch = block.match(/url\s*:\s*["']([^"']+)["']/);
                if (!urlMatch) return null;
                
                let streamUrl = urlMatch[1];
                // Fix protocol-relative URLs
                if (streamUrl.startsWith('//')) streamUrl = 'https:' + streamUrl;
                
                // Extraer clearkey DRM keys
                let k1 = null, k2 = null;
                // Formato antiguo: k1: "...", k2: "..."
                const k1Match = block.match(/k1\s*:\s*["']([^"']+)["']/);
                const k2Match = block.match(/k2\s*:\s*["']([^"']+)["']/);
                if (k1Match && k2Match) {
                    k1 = k1Match[1];
                    k2 = k2Match[1];
                } else {
                    // Formato nuevo: clearkey: { 'keyId': 'keyValue' }
                    const ckBlock = block.match(/clearkey\s*:\s*\{([\s\S]+?)\}/);
                    if (ckBlock) {
                        const ckPair = ckBlock[1].match(/['"]([a-f0-9]+)['"]\s*:\s*['"]([a-f0-9]+)['"]/);
                        if (ckPair) {
                            k1 = ckPair[1];
                            k2 = ckPair[2];
                        }
                    }
                }
                
                return { url: streamUrl, k1, k2 };
            }
        }

        // 5) Fallback: buscar cualquier .mpd URL en el HTML
        const mpdFallback = html.match(/["']([^"']*\.mpd[^"']*)["']/);
        if (mpdFallback) {
            let url = mpdFallback[1];
            if (url.startsWith('//')) url = 'https:' + url;
            return { url };
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

// ─── Fuentes de scraping ───
const SOURCES = [
    { url: 'https://futbol-libre.su/agenda/', origin: 'https://futbol-libre.su' },
    { url: 'https://pelotalibretv.su/agenda/', origin: 'https://pelotalibretv.su' }
];

// ─── Parsear partidos de un HTML de agenda ───
function parseMatches(html, sourceOrigin) {
    const $ = cheerio.load(html);
    const agendaTitle = $('.sombreada_css3').text().trim() || 'Agenda Deportiva';
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
            const quality = $opt.find('span').first().text().trim() || 'HD';
            let channel = $opt.text().replace(quality, '').trim();
            if (!channel) channel = 'Opción ' + (options.length + 1);

            let href = $opt.attr('href') || '';
            if (href && (href.includes('?r=') || href.includes('eventos'))) {
                if (href.startsWith('/')) href = sourceOrigin + href;
                else if (!href.startsWith('http')) href = sourceOrigin + '/' + href;
                options.push({ channel, quality, href, stream: null, sourceOrigin });
            }
        });

        const leagueLogo = aTag.find('img').attr('src') || '';

        if (matchName) {
            matches.push({ countryClass, time, matchName, options, leagueLogo });
        }
    });

    return { agendaTitle, matches };
}

// ─── Normalizar nombre de partido para deduplicación ───
function normalizeMatchKey(matchName, time) {
    return (matchName + '|' + time).toLowerCase().replace(/\s+/g, ' ').trim();
}

// ─── Clave única de una opción de streaming (por base64 del param r=) ───
function optionKey(opt) {
    const rMatch = opt.href.match(/r=([^&]+)/);
    return rMatch ? rMatch[1] : opt.href;
}

// ─── Mergear partidos de múltiples fuentes, deduplicando ───
function mergeMatches(allParsed) {
    const map = new Map();

    for (const { matches } of allParsed) {
        for (const match of matches) {
            const key = normalizeMatchKey(match.matchName, match.time);
            if (map.has(key)) {
                // Mergear opciones evitando duplicados
                const existing = map.get(key);
                const existingKeys = new Set(existing.options.map(optionKey));
                for (const opt of match.options) {
                    if (!existingKeys.has(optionKey(opt))) {
                        existing.options.push(opt);
                        existingKeys.add(optionKey(opt));
                    }
                }
                // Usar logo si no tenía
                if (!existing.leagueLogo && match.leagueLogo) {
                    existing.leagueLogo = match.leagueLogo;
                }
            } else {
                map.set(key, { ...match, options: [...match.options] });
            }
        }
    }

    return Array.from(map.values());
}

// ─── Scraping principal ───
async function scrapeMatches(writeToDisk = true) {
    const startTime = Date.now();
    console.log(`Scraping agenda desde ${SOURCES.length} fuentes...\n`);

    // ─── 1. Fetch ambas fuentes en paralelo ───
    const fetchHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
        'Accept-Language': 'es-ES,es;q=0.9'
    };

    const results = await Promise.allSettled(
        SOURCES.map(async (source) => {
            const res = await fetch(source.url, { headers: fetchHeaders });
            if (!res.ok) throw new Error(`HTTP ${res.status} from ${source.url}`);
            const html = await res.text();
            console.log(`  ✓ ${source.origin} descargado`);
            return parseMatches(html, source.origin);
        })
    );

    const allParsed = [];
    let agendaTitle = 'Agenda Deportiva';
    for (const r of results) {
        if (r.status === 'fulfilled') {
            allParsed.push(r.value);
            agendaTitle = r.value.agendaTitle;
        } else {
            console.error(`  ✗ Error en una fuente: ${r.reason.message}`);
        }
    }

    if (allParsed.length === 0) throw new Error('No se pudo acceder a ninguna fuente');

    // ─── 2. Mergear y deduplicar ───
    const matches = mergeMatches(allParsed);
    const totalOptions = matches.reduce((sum, m) => sum + m.options.length, 0);
    console.log(`\nPartidos: ${matches.length} | Servidores totales: ${totalOptions}`);
    console.log('Resolviendo URLs...\n');

    // ─── 3. Resolver URLs (concurrencia global) ───
    let resolved = 0, failed = 0;

    const optionsToResolve = [];
    for (const match of matches) {
        for (const opt of match.options) {
            const decoded = decodeStreamUrl(opt.href);
            if (decoded) {
                optionsToResolve.push({
                    opt, decoded,
                    matchName: match.matchName,
                    referer: (opt.sourceOrigin || 'https://pelotalibretv.su') + '/'
                });
            }
        }
    }

    for (let i = 0; i < optionsToResolve.length; i += CONCURRENCY) {
        const batch = optionsToResolve.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (item) => {
            try {
                const result = await getStreamUrl(item.decoded, item.referer);
                item.opt.stream = result;
                if (result) resolved++;
                else failed++;
            } catch {
                failed++;
            }
        }));
    }

    console.log(`\nResueltos: ${resolved} | Fallidos: ${failed}\n`);

    // ─── 4. Generar partidos.txt ───
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

    // ─── 5. Generar index.html ───
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
    const countries = new Set();
    const leagues = new Set();

    for (const match of matches) {
        if (match.countryClass) countries.add(match.countryClass);
        // Intentar extraer liga si existe en el nombre (ej: "Ligue 1: ...")
        if (match.matchName.includes(':')) {
            leagues.add(match.matchName.split(':')[0].trim());
        }
    }

    const sortedCountries = Array.from(countries).sort();
    const sortedLeagues = Array.from(leagues).sort();

    let matchesHtml = '';
    let streamIndex = 0;
    const streamData = []; 

    for (const match of matches) {
        let optionsHtml = '';

        for (const opt of match.options) {
            const idx = streamIndex++;
            const decoded = decodeStreamUrl(opt.href);
            if (opt.stream) {
                streamData.push({
                    url: opt.stream.url,
                    k1: opt.stream.k1 || null,
                    k2: opt.stream.k2 || null,
                    raw: decoded || null
                });
            } else {
                // Servidor no resuelto en el momento del scraping
                streamData.push({
                    url: null,
                    k1: null,
                    k2: null,
                    raw: decoded || null
                });
            }
            const isPending = !opt.stream;
            optionsHtml += `
                <a href="#" class="stream-link${isPending ? ' stream-pending' : ''}" onclick="playStream(${idx});return false;">
                    <span class="stream-name">${esc(opt.channel)}</span>
                    <span class="stream-quality">${esc(opt.quality)}${isPending ? ' ⏳' : ''}</span>
                </a>`;
        }

        const matchLeague = match.matchName.includes(':') ? match.matchName.split(':')[0].trim() : '';
        const logoUrl = match.leagueLogo ? (match.leagueLogo.startsWith('http') ? match.leagueLogo : 'https://pelotalibretv.su' + match.leagueLogo) : '';
        
        // Normalizar clases de país para CSS (ej: "menu-item ES" -> "ES")
        const cleanCountryClass = match.countryClass.split(' ').filter(c => c !== 'menu-item').join(' ');

        matchesHtml += `
        <li class="${esc(cleanCountryClass)} match-card" data-league="${esc(matchLeague)}">
            <a href="#" class="match-header ${match.options.length === 0 ? 'no-links pending' : ''}">
                <div class="match-info">
                    <span class="match-league">
                        <span class="flag-icon"></span>
                        ${logoUrl ? `<img src="${logoUrl}" class="league-logo" alt="logo">` : ''}
                        <span class="league-name">${esc(matchLeague || 'Varios')}</span>
                    </span>
                    <span class="match-title">${esc(match.matchName.includes(':') ? match.matchName.split(':')[1].trim() : match.matchName)}</span>
                </div>
                <span class="match-time">${esc(match.time)}</span>
            </a>
            <div class="stream-options">
                ${match.options.length > 0 ? optionsHtml : '<div class="no-streams">No hay links disponibles todavía</div>'}
            </div>
        </li>`;
    }

    let countryFiltersHtml = '<div class="filter-item active" data-filter="all">Todos los Países</div>';
    for (const c of sortedCountries) {
        const cleanC = c.split(' ').filter(x => x !== 'menu-item').join(' ');
        countryFiltersHtml += `<div class="filter-item ${esc(cleanC)}" data-filter=".${esc(cleanC)}"><span class="flag-icon"></span> ${esc(cleanC)}</div>`;
    }

    let leagueFiltersHtml = '<div class="filter-item active" data-filter="all">Todas las Ligas</div>';
    for (const l of sortedLeagues) {
        leagueFiltersHtml += `<div class="filter-item" data-filter="${esc(l)}">${esc(l)}</div>`;
    }

    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Futbol Libre - Premium Edition</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0f172a;
            --card-bg: rgba(30, 41, 59, 0.7);
            --card-border: rgba(255, 255, 255, 0.1);
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --accent-color: #84cc16;
            --accent-hover: #a3e635;
            --danger: #ef4444;
            --glass-blur: blur(12px);
            --transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
            -webkit-tap-highlight-color: transparent;
        }

        body {
            font-family: 'Outfit', sans-serif;
            background-color: var(--bg-color);
            background-image: 
                radial-gradient(at 0% 0%, rgba(132, 204, 22, 0.15) 0px, transparent 50%),
                radial-gradient(at 100% 0%, rgba(59, 130, 246, 0.1) 0px, transparent 50%);
            color: var(--text-primary);
            min-height: 100vh;
            line-height: 1.5;
            overflow-x: hidden;
            display: flex;
            flex-direction: column;
        }

        /* --- Layout --- */
        .main-wrapper {
            display: flex;
            width: 100%;
            max-width: 1400px;
            margin: 0 auto;
            flex: 1;
        }

        /* --- Sidebar --- */
        aside {
            width: 280px;
            padding: 2rem 1.5rem;
            border-right: 1px solid var(--card-border);
            height: calc(100vh - 120px);
            position: sticky;
            top: 120px;
            overflow-y: auto;
            scrollbar-width: thin;
            scrollbar-color: var(--card-border) transparent;
        }

        aside::-webkit-scrollbar { width: 4px; }
        aside::-webkit-scrollbar-thumb { background: var(--card-border); border-radius: 10px; }

        .sidebar-section {
            margin-bottom: 1.5rem;
            background: rgba(255, 255, 255, 0.02);
            border-radius: 1rem;
            border: 1px solid var(--card-border);
            overflow: hidden;
        }

        .sidebar-title {
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            color: var(--text-primary);
            padding: 1rem;
            font-weight: 700;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: pointer;
            background: rgba(255, 255, 255, 0.03);
            transition: var(--transition);
        }

        .sidebar-title:hover {
            background: rgba(255, 255, 255, 0.05);
        }

        .sidebar-title::after {
            content: '▼';
            font-size: 0.6rem;
            transition: transform 0.3s ease;
            opacity: 0.5;
        }

        .sidebar-section.collapsed .sidebar-title::after {
            transform: rotate(-90deg);
        }

        .filter-list {
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
            padding: 0.5rem;
            transition: max-height 0.3s ease, padding 0.3s ease;
            max-height: 500px;
        }

        .sidebar-section.collapsed .filter-list {
            max-height: 0;
            padding: 0;
            overflow: hidden;
        }

        .filter-item {
            padding: 0.6rem 1rem;
            border-radius: 0.75rem;
            cursor: pointer;
            font-size: 0.9rem;
            color: var(--text-secondary);
            transition: var(--transition);
            display: flex;
            align-items: center;
            gap: 0.75rem;
            border: 1px solid transparent;
        }

        .filter-item:hover {
            background: rgba(255, 255, 255, 0.05);
            color: var(--text-primary);
        }

        .filter-item.active {
            background: rgba(132, 204, 22, 0.1);
            color: var(--accent-color);
            border-color: rgba(132, 204, 22, 0.2);
        }

        .filter-item .flag-icon {
            width: 20px;
            height: 20px;
            background-size: 83px 666px; /* Ajuste proporcional para sidebar */
            flex-shrink: 0;
        }

        .league-logo {
            width: 20px;
            height: 20px;
            object-fit: contain;
            border-radius: 4px;
        }

        /* --- Header --- */
        header {
            position: sticky;
            top: 0;
            z-index: 100;
            background: rgba(15, 23, 42, 0.9);
            backdrop-filter: var(--glass-blur);
            -webkit-backdrop-filter: var(--glass-blur);
            border-bottom: 1px solid var(--card-border);
            padding: 0.75rem 1.5rem;
            display: flex;
            flex-direction: column;
            gap: 1rem;
        }

        .header-top {
            width: 100%;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        /* --- Search Bar --- */
        .search-container {
            width: 100%;
            position: relative;
        }

        #match-search {
            width: 100%;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--card-border);
            padding: 0.8rem 1.2rem 0.8rem 2.8rem;
            border-radius: 1rem;
            color: var(--text-primary);
            font-family: 'Outfit', sans-serif;
            font-size: 1rem;
            outline: none;
            transition: var(--transition);
        }

        #match-search:focus {
            background: rgba(255, 255, 255, 0.08);
            border-color: var(--accent-color);
            box-shadow: 0 0 0 2px rgba(132, 204, 22, 0.2);
        }

        .search-icon {
            position: absolute;
            left: 1rem;
            top: 50%;
            transform: translateY(-50%);
            color: var(--text-secondary);
            pointer-events: none;
        }

        .logo {
            font-size: 1.5rem;
            font-weight: 700;
            background: linear-gradient(135deg, var(--accent-color), #3b82f6);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .logo span {
            color: var(--text-primary);
            -webkit-text-fill-color: var(--text-primary);
            font-weight: 400;
            font-size: 0.9rem;
            opacity: 0.8;
        }

        #btn-refresh {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            color: var(--text-primary);
            padding: 0.6rem 1.2rem;
            border-radius: 99px;
            font-size: 0.9rem;
            font-weight: 600;
            text-decoration: none;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            transition: var(--transition);
        }

        #btn-refresh:hover {
            background: var(--accent-color);
            color: var(--bg-color);
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(132, 204, 22, 0.3);
        }

        /* --- Content Area --- */
        .content-area {
            flex: 1;
            padding: 2rem;
            max-width: 1100px;
        }

        .container {
            width: 100%;
        }

        .date-badge {
            display: inline-block;
            background: rgba(132, 204, 22, 0.1);
            color: var(--accent-color);
            padding: 0.4rem 1rem;
            border-radius: 99px;
            font-size: 0.85rem;
            font-weight: 600;
            margin-bottom: 1.5rem;
            border: 1px solid rgba(132, 204, 22, 0.2);
        }

        /* --- Match List --- */
        .match-list {
            display: grid;
            gap: 1rem;
            list-style: none;
        }

        .match-card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 1.5rem;
            overflow: hidden;
            transition: var(--transition);
            backdrop-filter: var(--glass-blur);
            -webkit-backdrop-filter: var(--glass-blur);
        }

        .match-card:hover {
            border-color: rgba(132, 204, 22, 0.4);
            transform: scale(1.01);
            box-shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.5);
        }

        .match-header {
            padding: 1.25rem 1.5rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            cursor: pointer;
            text-decoration: none;
            color: inherit;
        }

        .match-info {
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
        }

        .match-title {
            font-size: 1.1rem;
            font-weight: 600;
            color: var(--text-primary);
        }

        .match-league {
            font-size: 0.8rem;
            color: var(--text-secondary);
            display: flex;
            align-items: center;
            gap: 0.6rem;
            margin-bottom: 0.2rem;
        }

        .league-name {
            text-transform: uppercase;
            letter-spacing: 0.05em;
            font-weight: 500;
        }

        /* --- Flag Icons System --- */
        .flag-icon {
            width: 24px;
            height: 24px;
            display: inline-block;
            background-image: url(https://pelotalibretv.su/agenda/spriteupdate8.png);
            background-repeat: no-repeat;
            background-size: 100px 800px; /* Ajuste para el sprite original */
            filter: drop-shadow(0 2px 4px rgba(0,0,0,0.2));
        }

        .LC .flag-icon { background-position: -75px -720px; }
        .VEN .flag-icon { background-position: -38px -725px; }
        .COL .flag-icon { background-position: 0 0; }
        .MEX .flag-icon { background-position: -38px 0; }
        .ES .flag-icon { background-position: 0 -38px; }
        .PE .flag-icon { background-position: -38px -38px; }
        .CAT .flag-icon { background-position: 0 -685px; }
        .ENG .flag-icon { background-position: -76px 0; }
        .FRA .flag-icon { background-position: -76px -38px; }
        .USA .flag-icon { background-position: 0 -76px; }
        .JA .flag-icon { background-position: -38px -76px; }
        .IT .flag-icon { background-position: 0 -114px; }
        .BRA .flag-icon { background-position: -38px -114px; }
        .ALE .flag-icon { background-position: -76px -76px; }
        .POR .flag-icon { background-position: -76px -114px; }
        .CH .flag-icon { background-position: 0 -152px; }
        .ECUA .flag-icon { background-position: -38px -152px; }
        .URU .flag-icon { background-position: 0 -190px; }
        .EURO .flag-icon { background-position: -38px -190px; }
        .AR .flag-icon { background-position: -76px -152px; }
        .AMERICA .flag-icon { background-position: -76px -190px; }
        .ARA .flag-icon { background-position: -37px -687px; }
        .PAR .flag-icon { background-position: 0 -608px; }
        .BOL .flag-icon { background-position: -76px -608px; }
        .PARA .flag-icon { background-position: 0 -646px; }
        .HOL .flag-icon { background-position: -38px -608px; }

        .no-links {
            opacity: 0.6;
            cursor: default;
        }
        
        .match-card.pending:hover {
            border-color: var(--card-border);
            transform: none;
        }

        .match-card.hidden {
            display: none;
        }

        .no-streams {
            grid-column: 1 / -1;
            padding: 1rem;
            text-align: center;
            color: var(--text-secondary);
            font-size: 0.9rem;
            font-style: italic;
        }

        .stream-pending {
            opacity: 0.6;
            border-style: dashed;
        }

        .stream-pending:hover {
            opacity: 1;
        }

        .match-time {
            background: rgba(255, 255, 255, 0.05);
            padding: 0.5rem 0.8rem;
            border-radius: 0.8rem;
            font-weight: 700;
            color: var(--accent-color);
            font-variant-numeric: tabular-nums;
        }

        .stream-options {
            display: none;
            padding: 0 1.5rem 1.5rem 1.5rem;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 0.75rem;
            border-top: 1px solid var(--card-border);
            padding-top: 1.25rem;
        }

        .match-card.active .stream-options {
            display: grid;
        }

        .stream-link {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--card-border);
            padding: 0.8rem 1rem;
            border-radius: 1rem;
            text-decoration: none;
            color: var(--text-primary);
            display: flex;
            flex-direction: column;
            gap: 0.2rem;
            transition: var(--transition);
        }

        .stream-link:hover {
            background: rgba(132, 204, 22, 0.1);
            border-color: var(--accent-color);
            transform: translateY(-2px);
        }

        .stream-name {
            font-weight: 600;
            font-size: 0.95rem;
        }

        .stream-quality {
            font-size: 0.75rem;
            color: var(--text-secondary);
        }

        /* --- Player Overlay --- */
        #player-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(2, 6, 23, 0.95);
            z-index: 1000;
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            justify-content: center;
            align-items: center;
            padding: 1rem;
        }

        #player-overlay.active {
            display: flex;
            animation: fadeIn 0.3s ease;
        }

        .player-container {
            width: 100%;
            max-width: 1100px;
            aspect-ratio: 16/9;
            background: #000;
            border-radius: 2rem;
            overflow: hidden;
            position: relative;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8);
            border: 1px solid var(--card-border);
        }

        #player-video {
            width: 100%;
            height: 100%;
        }

        #player-close {
            position: absolute;
            top: 1.5rem;
            right: 1.5rem;
            background: rgba(0, 0, 0, 0.5);
            color: white;
            width: 3rem;
            height: 3rem;
            border-radius: 50%;
            display: flex;
            justify-content: center;
            align-items: center;
            font-size: 1.5rem;
            cursor: pointer;
            z-index: 1010;
            transition: var(--transition);
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        #player-close:hover {
            background: var(--danger);
            transform: rotate(90deg);
        }

        #player-status {
            position: absolute;
            bottom: 1.5rem;
            left: 1.5rem;
            background: rgba(0, 0, 0, 0.6);
            padding: 0.5rem 1rem;
            border-radius: 0.75rem;
            font-size: 0.85rem;
            color: var(--accent-color);
            pointer-events: none;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }

        @media (max-width: 1024px) {
            aside { display: none; }
            .main-wrapper { padding: 0 1rem; }
            .content-area { padding: 1.5rem 0; }
        }

        @media (max-width: 640px) {
            header { padding: 0.75rem 1rem; }
            .match-header { padding: 1rem; }
            .stream-options { grid-template-columns: 1fr; }
            .match-title { font-size: 1rem; }
            .player-container { border-radius: 1rem; }
        }
    </style>
    <script src="https://ajax.googleapis.com/ajax/libs/jquery/3.6.0/jquery.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
    <script src="https://cdn.jsdelivr.net/npm/shaka-player@4/dist/shaka-player.compiled.js"></script>
</head>
<body>

<header>
    <div class="header-top">
        <div class="logo">⚽ FUTBOL <span>LIBRE</span></div>
        <a id="btn-refresh" href="#" onclick="location.reload();return false;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path></svg>
            Recargar
        </a>
    </div>
    <div class="search-container">
        <svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
        <input type="text" id="match-search" placeholder="Buscar partido, equipo o liga...">
    </div>
</header>

<div class="main-wrapper">
    <aside>
        <div class="sidebar-section collapsed">
            <div class="sidebar-title" onclick="toggleSidebar(this)">Países</div>
            <div class="filter-list" id="country-filters">
                ${countryFiltersHtml}
            </div>
        </div>
        <div class="sidebar-section collapsed">
            <div class="sidebar-title" onclick="toggleSidebar(this)">Ligas</div>
            <div class="filter-list" id="league-filters">
                ${leagueFiltersHtml}
            </div>
        </div>
    </aside>

    <main class="content-area">
        <div class="container">
            <div class="date-badge" id="current-date">Agenda - ${esc(title)}</div>
            
            <div class="match-list">
                ${matchesHtml}
            </div>
        </div>
    </main>
</div>

<div id="player-overlay">
    <div class="player-container">
        <span id="player-close" onclick="closePlayer()">&times;</span>
        <video id="player-video" controls autoplay playsinline webkit-playsinline></video>
        <div id="player-status">Listo para reproducir</div>
    </div>
</div>

<script>
    var STREAMS = ${JSON.stringify(streamData)};
    var currentHls = null;
    var currentShaka = null;

    function playStream(idx) {
        var s = STREAMS[idx];
        if (!s) return;
        
        var video = document.getElementById('player-video');
        var overlay = document.getElementById('player-overlay');
        var status = document.getElementById('player-status');
        
        closePlayerInternal();
        overlay.classList.add('active');
        status.textContent = 'Cargando stream...';

        if (!s.url) {
            status.textContent = 'Stream no disponible';
            return;
        }
        
        startPlayback(s, video, status);
    }

    function startPlayback(s, video, status) {
        var url = s.url;
        if (!url) { status.textContent = 'URL no disponible'; return; }
        
        if (url.indexOf('.m3u8') !== -1) {
            if (Hls.isSupported()) {
                currentHls = new Hls({ maxBufferLength: 30 });
                currentHls.loadSource(url);
                currentHls.attachMedia(video);
                currentHls.on(Hls.Events.MANIFEST_PARSED, function() {
                    status.textContent = 'HLS ▶ Reproduciendo';
                    video.play().catch(function(){});
                });
                currentHls.on(Hls.Events.ERROR, function(ev, data) {
                    if (data.fatal) status.textContent = 'Error HLS: ' + data.type;
                });
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = url;
                video.play().catch(function(){});
                status.textContent = 'HLS nativo ▶ Reproduciendo';
            }
        } else if (url.indexOf('.mpd') !== -1) {
            shaka.polyfill.installAll();
            var player = new shaka.Player(video);
            currentShaka = player;

            if (s.k1 && s.k2) {
                var keys = {}; keys[s.k1] = s.k2;
                player.configure({ drm: { clearKeys: keys } });
            }
            
            player.load(url).then(function() {
                status.textContent = 'DASH' + (s.k1 ? ' (DRM)' : '') + ' ▶ Reproduciendo';
                video.play().catch(function(){});
            }).catch(function(err) {
                status.textContent = 'Error DASH: ' + err.code;
            });
        }
    }

    function closePlayer() {
        closePlayerInternal();
        document.getElementById('player-overlay').classList.remove('active');
    }

    function closePlayerInternal() {
        var video = document.getElementById('player-video');
        if (currentHls) { currentHls.destroy(); currentHls = null; }
        if (currentShaka) { currentShaka.destroy().catch(function(){}); currentShaka = null; }
        video.removeAttribute('src');
        video.load();
    }

    $(function() {
        $('.match-header').click(function(e) {
            e.preventDefault();
            var card = $(this).closest('.match-card');
            if (card.hasClass('active')) {
                card.removeClass('active');
            } else {
                $('.match-card').removeClass('active');
                card.addClass('active');
            }
        });

        $(document).keydown(function(e) { if (e.key === 'Escape') closePlayer(); });
        $('#player-overlay').click(function(e) { if (e.target === this) closePlayer(); });

        // --- Buscador ---
        $('#match-search').on('input', function() {
            var query = $(this).val().toLowerCase().trim();
            filterMatches(query, 'search');
        });

        // --- Sidebar ---
        window.toggleSidebar = function(el) {
            $(el).closest('.sidebar-section').toggleClass('collapsed');
        }

        // --- Filtros Sidebar ---
        $('#country-filters .filter-item').on('click', function() {
            $('#country-filters .filter-item').removeClass('active');
            $(this).addClass('active');
            var filter = $(this).data('filter');
            filterMatches(filter, 'country');
        });

        $('#league-filters .filter-item').on('click', function() {
            $('#league-filters .filter-item').removeClass('active');
            $(this).addClass('active');
            var filter = $(this).data('filter');
            filterMatches(filter, 'league');
        });

        function filterMatches(val, type) {
            $('.match-card').each(function() {
                var show = false;
                if (type === 'search') {
                    show = $(this).text().toLowerCase().indexOf(val) !== -1;
                } else if (type === 'country') {
                    show = (val === 'all' || $(this).is(val));
                } else if (type === 'league') {
                    show = (val === 'all' || $(this).data('league') === val);
                }

                if (show) $(this).removeClass('hidden');
                else $(this).addClass('hidden');
            });
        }

        var offsetMin = (new Date().getTimezoneOffset() * -1) - 60; 
        if (offsetMin !== 0) {
            $('.match-time').each(function() {
                var parts = $(this).text().split(':');
                if (parts.length === 2) {
                    var d = new Date();
                    d.setHours(parseInt(parts[0], 10));
                    d.setMinutes(parseInt(parts[1], 10) + offsetMin);
                    $(this).text(d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0'));
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

// (sleep removed — unused)

if (require.main === module) {
    scrapeMatches(true).catch(err => console.error('Error fatal:', err));
}

module.exports = { scrapeMatches, getStreamUrl };

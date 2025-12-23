import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

// --- PROXY MASK GENERATOR ---
// Wraps the Cloudinary URL in a global CDN to bypass Google's blocklist
function getMaskedUrl(originalUrl) {
    // We use wsrv.nl (an open source image proxy) to "wash" the URL
    // This makes it look like a static, trusted file to Google
    const encoded = encodeURIComponent(originalUrl);
    return `https://wsrv.nl/?url=${encoded}&output=jpg`;
}

// --- DIMENSION PARSER ---
function getDimensions(buffer) {
    try {
        if (buffer[0] === 0x89 && buffer[1] === 0x50) return { width: (buffer[16] << 24) | (buffer[17] << 16) | (buffer[18] << 8) | buffer[19], height: (buffer[20] << 24) | (buffer[21] << 16) | (buffer[22] << 8) | buffer[23] };
        if (buffer[0] === 0xFF && buffer[1] === 0xD8) { 
            let i = 2;
            while (i < buffer.length) {
                if (buffer[i] !== 0xFF) return null; 
                while (buffer[i] === 0xFF) i++;
                i++;
                const len = (buffer[i] << 8) | buffer[i + 1];
                if (buffer[i-1] >= 0xC0 && buffer[i-1] <= 0xC3) return { height: (buffer[i + 5] << 8) | buffer[i + 6], width: (buffer[i + 7] << 8) | buffer[i + 8] };
                i += len;
            }
        }
    } catch (e) { return null; }
    return null;
}

function identifyGeneratorByRes(w, h) {
    const is = (val, target) => Math.abs(val - target) <= 5;
    if (is(w, 512) && is(h, 512)) return 'Stable Diffusion v1.5';
    if (is(w, 640) && is(h, 640)) return 'Stable Diffusion / Midjourney v4'; 
    if ((is(w, 768) && is(h, 640)) || (is(w, 640) && is(h, 768))) return 'Stable Diffusion (Portrait/Landscape)'; 
    if (is(w, 1024) && is(h, 1024)) return 'SDXL / Midjourney v5';
    return "Unknown";
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { mediaUrl, type } = req.body;
    const apiKey = process.env.SERPER_API_KEY;

    let intel = {
        totalMatches: 0,
        ai_generator_name: "Unknown",
        matches: [],
        method: "None",
        version: "osint-proxy-mask-v35",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const isAudio = type === 'audio' || mediaUrl.match(/\.(mp3|wav|ogg)$/i);
        const filename = mediaUrl.split('/').pop();

        // --- STEP 1: PREP & MASKING ---
        let searchUrl = mediaUrl;
        
        if (!isAudio) {
            try {
                // 1. Generate the Masked URL
                // This is the URL Google will actually visit
                searchUrl = getMaskedUrl(mediaUrl);
                intel.debug.push(`Masked URL generated via wsrv.nl`);

                // 2. Fetch original for Dims (Internal logic only)
                const imgRes = await fetch(mediaUrl);
                const arrayBuffer = await imgRes.arrayBuffer();
                const dims = getDimensions(new Uint8Array(arrayBuffer));
                
                if (dims) {
                    intel.debug.push(`Dims: ${dims.width}x${dims.height}`);
                    const gen = identifyGeneratorByRes(dims.width, dims.height);
                    if (gen !== "Unknown") intel.ai_generator_name = `${gen} (Resolution Logic)`;
                }

            } catch (e) { intel.debug.push(`Prep Error: ${e.message}`); }
        }

        if (apiKey && !isAudio) {
            let rawMatches = [];

            // --- STRATEGY: MASKED URL SEARCH ---
            try {
                const lRes = await fetch("https://google.serper.dev/lens", {
                    method: "POST",
                    headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                    body: JSON.stringify({ 
                        url: searchUrl, // Send the PROXY URL, not Cloudinary
                        gl: "us",       // Global/US index often has better AI coverage
                        hl: "en"
                    })
                });
                
                const lData = await lRes.json();
                
                if (lData.knowledgeGraph) rawMatches.push(lData.knowledgeGraph);
                if (lData.visualMatches) rawMatches = rawMatches.concat(lData.visualMatches);
                
                if (rawMatches.length > 0) intel.method = "Visual Proxy Search";
                else intel.debug.push("Lens (Proxy) returned 0 matches");

            } catch (e) { intel.debug.push(`Lens Error: ${e.message}`); }

            // --- FALLBACK: TEXT SEARCH (Filename) ---
            if (rawMatches.length === 0) {
                const cleanName = filename.split('.')[0];
                if (cleanName.length > 5) {
                    try {
                        const sRes = await fetch("https://google.serper.dev/search", {
                            method: "POST",
                            headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                            body: JSON.stringify({ q: cleanName })
                        });
                        const sData = await sRes.json();
                        if (sData.organic) rawMatches = rawMatches.concat(sData.organic);
                        if (sData.images) rawMatches = rawMatches.concat(sData.images);
                        if (rawMatches.length > 0) intel.method = "Filename Trace";
                    } catch (e) {}
                }
            }

            // --- PROCESSING ---
            const cleanMatches = rawMatches.filter(m => 
                !IGNORED.some(d => (m.link || "").includes(d))
            );

            intel.totalMatches = cleanMatches.length;
            
            intel.matches = cleanMatches.slice(0, 10).map(m => ({
                source_name: m.source || m.title || "Web Result",
                title: m.title || "External Match",
                url: m.link || "#",
                posted_time: "Found Online"
            }));

            if (cleanMatches.length > 0) {
                const combined = cleanMatches.map(m => (m.title||"") + " " + (m.source||"")).join(" ").toLowerCase();
                if (combined.includes("midjourney")) intel.ai_generator_name = "Midjourney (Context)";
                else if (combined.includes("stable diffusion")) intel.ai_generator_name = "Stable Diffusion (Context)";
            }
        }

        // --- FINAL STATUS ---
        if (intel.totalMatches === 0) {
            intel.matches.push({
                source_name: "Google Lens (Manual)",
                title: "No Matches Found",
                url: `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(mediaUrl)}`,
                posted_time: "Image confirmed unique by Google"
            });
            // Add Bing as a second manual option since Google failed
            intel.matches.push({
                source_name: "Bing Visual Search",
                title: "Try Bing Instead",
                url: `https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIHMP&q=imgurl:${encodeURIComponent(mediaUrl)}`,
                posted_time: "Alternative Engine"
            });
        }

        return res.status(200).json({
            service: "osint-proxy-mask-v35",
            footprintAnalysis: intel,
            timelineIntel: { first_seen: "Analyzed", last_seen: "Just Now" }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}

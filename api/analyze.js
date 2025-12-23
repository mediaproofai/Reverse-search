import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

// --- LIGHTWEIGHT MULTIPART CONSTRUCTOR (No Libraries) ---
// This builds a standard HTTP file upload manually to save processing time.
function buildMultipart(buffer, boundary) {
    const CRLF = "\r\n";
    const filename = "image.jpg";
    
    // Strict HTTP Multipart format
    const header = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${filename}"`,
        `Content-Type: image/jpeg`,
        CRLF
    ].join(CRLF); // Ensure strict CRLF

    // Combine: Header + Binary Image + Footer
    const headerBuf = Buffer.from(header);
    const footerBuf = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
    
    return Buffer.concat([headerBuf, buffer, footerBuf]);
}

// --- DIMENSION PARSER (Fast) ---
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
        version: "osint-speed-v29",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const isAudio = type === 'audio' || mediaUrl.match(/\.(mp3|wav|ogg)$/i);
        const filename = mediaUrl.split('/').pop();

        // --- STEP 1: DOWNLOAD & PREP (Fast Mode) ---
        let imgBuffer = null;
        if (!isAudio) {
            try {
                // Use a smaller version for speed (1000px is plenty for Lens)
                const fetchUrl = mediaUrl.includes('cloudinary') ? mediaUrl.replace('/upload/', '/upload/w_1000,q_auto/') : mediaUrl;
                
                const imgRes = await fetch(fetchUrl);
                const arrayBuffer = await imgRes.arrayBuffer();
                imgBuffer = Buffer.from(arrayBuffer);
                
                // Parse Dims
                const dims = getDimensions(new Uint8Array(arrayBuffer));
                if (dims) {
                    intel.debug.push(`Dims: ${dims.width}x${dims.height}`);
                    const gen = identifyGeneratorByRes(dims.width, dims.height);
                    if (gen !== "Unknown") intel.ai_generator_name = `${gen} (Resolution Logic)`;
                }
            } catch (e) { intel.debug.push(`Download Error: ${e.message}`); }
        }

        // --- STEP 2: MULTIPART UPLOAD (Manual) ---
        if (apiKey && !isAudio && imgBuffer) {
            let rawMatches = [];

            try {
                const boundary = "----WebKitFormBoundarySpeedTest";
                const body = buildMultipart(imgBuffer, boundary);
                
                intel.debug.push(`Sending ${Math.round(body.length/1024)}KB via Multipart`);

                const lRes = await fetch("https://google.serper.dev/lens", {
                    method: "POST",
                    headers: { 
                        "X-API-KEY": apiKey, 
                        "Content-Type": `multipart/form-data; boundary=${boundary}`,
                        "Content-Length": body.length.toString()
                    },
                    body: body
                });
                
                if (!lRes.ok) {
                    const txt = await lRes.text();
                    intel.debug.push(`API Error: ${lRes.status} - ${txt}`);
                } else {
                    const lData = await lRes.json();
                    if (lData.knowledgeGraph) rawMatches.push(lData.knowledgeGraph);
                    if (lData.visualMatches) rawMatches = rawMatches.concat(lData.visualMatches);
                    
                    if (rawMatches.length > 0) intel.method = "Visual Multipart (Fast)";
                    else intel.debug.push("Lens (Multipart) returned 0 matches");
                }
            } catch (e) { intel.debug.push(`Upload Error: ${e.message}`); }

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

        // --- FALLBACK: MANUAL LINK (Always Valid) ---
        if (intel.totalMatches === 0) {
            intel.matches.push({
                source_name: "Google Lens (Manual)",
                title: "Click to Verify (API Timed Out or Blocked)",
                url: `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(mediaUrl)}`,
                posted_time: "Manual Check Required"
            });
        }

        return res.status(200).json({
            service: "osint-speed-v29",
            footprintAnalysis: intel,
            timelineIntel: { first_seen: "Analyzed", last_seen: "Just Now" }
        });

    } catch (e) {
        return res.status(200).json({ error: e.message, service: "osint-crash" });
    }
}

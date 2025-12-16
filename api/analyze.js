import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

// EXTENDED GENERATOR DATABASE (Audio + Video + Image)
const AI_LABS = [
    // VIDEO / IMAGE
    { name: 'Midjourney', keys: ['midjourney', 'mj_'] },
    { name: 'DALL-E', keys: ['dalle', 'dall-e'] },
    { name: 'Stable Diffusion', keys: ['stable diffusion', 'sdxl', 'civitai'] },
    { name: 'Sora', keys: ['sora', 'openai'] },
    { name: 'Runway', keys: ['runway'] },
    { name: 'Pika', keys: ['pika'] },
    // AUDIO (New!)
    { name: 'ElevenLabs', keys: ['elevenlabs', '11labs'] },
    { name: 'Suno AI', keys: ['suno'] },
    { name: 'Udio', keys: ['udio'] },
    { name: 'RVC', keys: ['rvc', 'voice-conversion', 'ai-cover'] }
];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { mediaUrl, type } = req.body; // We now use the 'type' field
    const apiKey = process.env.SERPER_API_KEY;

    let intel = {
        totalMatches: 0,
        ai_generator_name: "Unknown",
        matches: [],
        method: "None",
        version: "osint-media-aware-v9",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        // --- PHASE 1: MEDIA TYPE DETECTION ---
        // Determine if we are dealing with Audio or Visual
        const isAudio = type === 'audio' || mediaUrl.match(/\.(mp3|wav|ogg|m4a)$/i);
        
        // --- PHASE 2: FILENAME FORENSICS ---
        const filename = mediaUrl.split('/').pop().toLowerCase();
        const cleanName = filename.split('.')[0].replace(/[-_]/g, ' ');
        
        for (const gen of AI_LABS) {
            if (gen.keys.some(k => filename.includes(k))) {
                intel.ai_generator_name = `${gen.name} (Filename Match)`;
            }
        }

        if (apiKey) {
            let rawMatches = [];

            // --- PHASE 3: SEARCH STRATEGY ---
            
            if (isAudio) {
                // STRATEGY A: AUDIO (Text Search Only)
                // Visual search is impossible for mp3. We search the filename text.
                intel.debug.push("Audio detected - Skipping Visual Search");
                
                if (cleanName.length > 3 && !cleanName.startsWith("audio")) {
                    try {
                        const textRes = await fetch("https://google.serper.dev/search", {
                            method: "POST",
                            headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                            body: JSON.stringify({ q: `"${cleanName}" audio`, gl: "us", hl: "en" })
                        });
                        const textData = await textRes.json();
                        if (textData.organic) {
                            rawMatches = textData.organic;
                            intel.method = "Filename Text Search";
                        }
                    } catch (e) { intel.debug.push("Audio Text Search Failed"); }
                }
            } else {
                // STRATEGY B: VISUAL (Google Lens)
                // For Images and Videos (using thumbnail)
                intel.debug.push("Visual media detected - Running Lens");
                try {
                    const lensRes = await fetch("https://google.serper.dev/lens", {
                        method: "POST",
                        headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                        body: JSON.stringify({ url: mediaUrl, gl: "us", hl: "en" })
                    });
                    const lensData = await lensRes.json();
                    if (lensData.knowledgeGraph) rawMatches.push(lensData.knowledgeGraph);
                    if (lensData.visualMatches) rawMatches = rawMatches.concat(lensData.visualMatches);
                    
                    if (rawMatches.length > 0) intel.method = "Visual Fingerprint";
                } catch (e) { intel.debug.push("Lens Failed"); }
            }

            // --- PHASE 4: PROCESSING ---
            const cleanMatches = rawMatches.filter(m => 
                !IGNORED.some(d => (m.link || "").includes(d))
            );

            intel.totalMatches = cleanMatches.length;
            
            // Map Results
            intel.matches = cleanMatches.slice(0, 8).map(m => ({
                source_name: m.source || new URL(m.link).hostname.replace('www.',''),
                title: m.title || "External Match",
                url: m.link || "#",
                posted_time: "Found Online"
            }));

            // Context Scan (Read titles for AI names)
            if (intel.ai_generator_name.includes("Unknown") && cleanMatches.length > 0) {
                const combinedText = cleanMatches.map(m => (m.title + " " + m.snippet).toLowerCase()).join(" ");
                for (const gen of AI_LABS) {
                    if (gen.keys.some(k => combinedText.includes(k))) {
                        intel.ai_generator_name = `${gen.name} (Context Match)`;
                        break;
                    }
                }
            }
        }

        // --- PHASE 5: INTELLIGENT FALLBACK ---
        if (intel.totalMatches === 0) {
            if (isAudio) {
                intel.matches.push({
                    source_name: "System",
                    title: "Audio Content Search Not Available",
                    url: "#",
                    posted_time: "Visual search cannot process audio files."
                });
            } else {
                intel.matches.push({
                    source_name: "System",
                    title: "No Public Visual Matches",
                    url: "#",
                    posted_time: "Image appears unique or private."
                });
            }
        }

        return res.status(200).json({
            service: "osint-media-aware-v9",
            footprintAnalysis: intel,
            timelineIntel: { 
                first_seen: intel.totalMatches > 0 ? "Publicly Indexed" : "Private",
                last_seen: "Just Now" 
            }
        });

    } catch (e) {
        return res.status(200).json({ service: "osint-crash", error: e.message });
    }
}

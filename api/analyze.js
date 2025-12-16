import fetch from 'node-fetch';

const IGNORED = ['cloudinary', 'vercel', 'blob:', 'discord', 'whatsapp'];

// AUDIO GENERATOR FINGERPRINTS (Filename Patterns)
const AUDIO_PATTERNS = [
    { name: 'ElevenLabs', regex: /^[a-zA-Z0-9]{20,}/ }, // Long alphanumeric IDs
    { name: 'Suno AI', regex: /suno/i },
    { name: 'Udio', regex: /udio/i },
    { name: 'RVC', regex: /rvc|model|pth/i }
];

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
        version: "osint-audio-v10",
        debug: []
    };

    if (!mediaUrl) return res.status(400).json({ error: "No mediaUrl" });

    try {
        const filename = mediaUrl.split('/').pop();
        const cleanName = filename.split('.')[0].replace(/[-_]/g, ' ');
        const isAudio = type === 'audio' || mediaUrl.match(/\.(mp3|wav|ogg|m4a)$/i);

        // --- PHASE 1: GENERATOR DETECTION (Filename Forensics) ---
        if (isAudio) {
            intel.ai_generator_name = "Synthetic Voice Engine (Likely)"; // Default assumption for anonymous audio
            
            for (const gen of AUDIO_PATTERNS) {
                if (gen.regex.test(filename)) {
                    intel.ai_generator_name = `${gen.name} (Pattern Match)`;
                }
            }
        }

        if (apiKey) {
            let rawMatches = [];

            // --- PHASE 2: SEARCH EXECUTION ---
            if (isAudio) {
                // AUDIO MODE: Strict Text Search
                // We search for the exact filename ID in case it was shared on a forum/Discord
                intel.debug.push(`Audio Mode: Searching text '${cleanName}'`);
                
                // Only search if the name isn't just a short generic word
                if (cleanName.length > 5) {
                    try {
                        const textRes = await fetch("https://google.serper.dev/search", {
                            method: "POST",
                            headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
                            body: JSON.stringify({ q: `"${cleanName}"`, gl: "us", hl: "en" })
                        });
                        const textData = await textRes.json();
                        rawMatches = textData.organic || [];
                        if (rawMatches.length > 0) intel.method = "Filename Trace";
                    } catch (e) { intel.debug.push("Audio search failed"); }
                }
            } else {
                // VISUAL MODE: Google Lens
                intel.debug.push("Visual Mode: Running Lens");
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
                } catch (e) { intel.debug.push("Lens failed"); }
            }

            // --- PHASE 3: RESULTS PROCESSING ---
            const cleanMatches = rawMatches.filter(m => 
                !IGNORED.some(d => (m.link || "").includes(d))
            );

            intel.totalMatches = cleanMatches.length;
            intel.matches = cleanMatches.slice(0, 8).map(m => ({
                source_name: m.source || m.title || "Web Result",
                title: m.title || "External Match",
                url: m.link || "#",
                posted_time: "Found Online"
            }));
        }

        // --- PHASE 4: FINAL CLEANUP ---
        if (intel.totalMatches === 0) {
            intel.matches.push({
                source_name: "System",
                title: "No Public Matches",
                url: "#",
                posted_time: "File ID not indexed publicly"
            });
        }

        return res.status(200).json({
            service: "osint-audio-v10",
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

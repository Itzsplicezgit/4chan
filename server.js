const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver'); // Requires 'archiver' npm package for zipping boards

const app = express();
const PORT = process.env.PORT || 3000;

// Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Storage Directories
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PENDING_DIR = path.join(__dirname, 'pending');
const DB_FILE = path.join(__dirname, 'database.json');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR);

// Master Password & Security
const ADMIN_PASSWORD = "admin"; // Replace with your secure password

// In-Memory Database Structure
let db = {
    boards: {
        all: { title: "All Content", type: "mixed", position: 1 },
        art: { title: "Artwork Collection", type: "images", position: 2 }
    },
    posts: [],
    pendingPosts: [],
    chatMessages: {} // Stores messages indexed by board key: { boardKey: [{ id, text, timestamp, ip }] }
};

// Load Database
if (fs.existsSync(DB_FILE)) {
    try {
        const fileData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        db = { ...db, ...fileData };
        // Ensure default properties exist
        if (!db.chatMessages) db.chatMessages = {};
        Object.keys(db.boards).forEach((key, index) => {
            if (db.boards[key].position === undefined) {
                db.boards[key].position = index + 1;
            }
        });
    } catch (e) {
        console.error("Error reading database.json, initializing fresh structure:", e);
    }
}

// Save Database Helper
function saveDatabase() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 4), 'utf8');
}

// IP-Based Cooldown Manager (1 Minute / 60,000 ms)
const COOLDOWN_MS = 60000;
const uploadCooldowns = new Map();
const chatCooldowns = new Map();

function checkCooldown(ip, cooldownMap) {
    const now = Date.now();
    if (cooldownMap.has(ip)) {
        const lastAction = cooldownMap.get(ip);
        const elapsed = now - lastAction;
        if (elapsed < COOLDOWN_MS) {
            return Math.ceil((COOLDOWN_MS - elapsed) / 1000);
        }
    }
    return 0;
}

function updateCooldown(ip, cooldownMap) {
    cooldownMap.set(ip, Date.now());
}

// Security Middleware
function adminAuth(req, res, next) {
    const providedPass = req.headers['x-admin-password'] || req.query.password;
    if (providedPass !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: "Invalid master system security passphrase." });
    }
    next();
}

// File Upload Engine Config (Multer)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // If uploaded by admin, go directly to live uploads, otherwise to pending
        const isAdmin = req.headers['x-admin-password'] === ADMIN_PASSWORD;
        cb(null, isAdmin ? UPLOADS_DIR : PENDING_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Unaccepted file format. Use standard images or videos.'));
        }
    }
});

// Serve Frontend Files
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/pending', express.static(PENDING_DIR));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// --- API ENDPOINTS ---

// Get Live Data Tree
app.get('/api/data', (req, res) => {
    const providedPass = req.headers['x-admin-password'];
    const isAdmin = providedPass === ADMIN_PASSWORD;

    // Filter out internal details for public feed if needed, or send sanitized payload
    const clientData = {
        boards: db.boards,
        posts: db.posts,
        chatMessages: db.chatMessages,
        pendingPosts: isAdmin ? db.pendingPosts : [] // Protect pending queue view
    };
    res.json(clientData);
});

// User Media Submission Queue
app.post('/api/posts/submit', (req, res) => {
    const clientIp = req.ip || req.headers['x-forwarded-for'];
    const remainingTime = checkCooldown(clientIp, uploadCooldowns);
    if (remainingTime > 0) {
        return res.status(429).json({ error: `Please wait ${remainingTime} seconds before submitting again.` });
    }

    upload.array('media', 10)(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No media files provided." });

        const targetBoard = req.body.board;
        if (!db.boards[targetBoard] || db.boards[targetBoard].type === 'chat') {
            return res.status(400).json({ error: "Invalid target media board." });
        }

        const newSubmissions = [];
        req.files.forEach(file => {
            const isVideo = file.mimetype.startsWith('video/');
            const postObj = {
                id: "pnd_" + Date.now() + "_" + Math.round(Math.random() * 100000),
                board: targetBoard,
                src: "/pending/" + file.filename,
                filename: file.filename,
                type: isVideo ? 'video' : 'image',
                timestamp: Date.now()
            };
            db.pendingPosts.push(postObj);
            newSubmissions.push(postObj);
        });

        updateCooldown(clientIp, uploadCooldowns);
        saveDatabase();
        res.json({ success: true, message: "Assets buffered in pending approval queue.", items: newSubmissions });
    });
});

// Admin Direct Upload (Bypasses Queue)
app.post('/api/posts/upload', adminAuth, (req, res) => {
    upload.array('media', 50)(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No media files provided." });

        const targetBoard = req.body.board;
        const customId = req.body.customId ? req.body.customId.trim().replace(/[^a-zA-Z0-9_-]/g, '') : null;

        if (!db.boards[targetBoard] || db.boards[targetBoard].type === 'chat') {
            return res.status(400).json({ error: "Invalid destination media board target." });
        }

        const processed = [];
        req.files.forEach((file, index) => {
            const isVideo = file.mimetype.startsWith('video/');
            const finalId = (customId && req.files.length === 1) ? customId : (Date.now() + "_" + index + "_" + Math.round(Math.random() * 1000));
            const postObj = {
                id: finalId,
                board: targetBoard,
                src: "/uploads/" + file.filename,
                filename: file.filename,
                type: isVideo ? 'video' : 'image',
                timestamp: Date.now()
            };
            db.posts.unshift(postObj);
            processed.push(postObj);
        });

        saveDatabase();
        res.json({ success: true, message: `Successfully published ${processed.length} assets live instantly!`, posts: processed });
    });
});

// Moderation Action (Approve / Deny Pending Upload)
app.post('/api/posts/approve', adminAuth, (req, res) => {
    const { id, action } = req.body;
    const targetIdx = db.pendingPosts.findIndex(p => p.id === id);

    if (targetIdx === -1) {
        return res.status(404).json({ error: "Pending item key not found in storage registers." });
    }

    const pendingItem = db.pendingPosts[targetIdx];

    if (action === 'approve') {
        const oldPath = path.join(PENDING_DIR, pendingItem.filename);
        const newPath = path.join(UPLOADS_DIR, pendingItem.filename);

        if (fs.existsSync(oldPath)) {
            fs.renameSync(oldPath, newPath);
            const livePost = {
                id: pendingItem.id.replace('pnd_', ''),
                board: pendingItem.board,
                src: "/uploads/" + pendingItem.filename,
                filename: pendingItem.filename,
                type: pendingItem.type,
                timestamp: Date.now()
            };
            db.posts.unshift(livePost);
        } else {
            return res.status(400).json({ error: "The associated physical file is missing from the pending storage node." });
        }
    } else if (action === 'reject') {
        const filePath = path.join(PENDING_DIR, pendingItem.filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }

    db.pendingPosts.splice(targetIdx, 1);
    saveDatabase();
    res.json({ success: true, action: action });
});

// Delete Post From Live Feed
app.post('/api/posts/delete', adminAuth, (req, res) => {
    const { id } = req.body;
    const postIdx = db.posts.findIndex(p => p.id === id);

    if (postIdx === -1) {
        return res.status(404).json({ error: "Post record search returned negative results." });
    }

    const targetPost = db.posts[postIdx];
    const physicalPath = path.join(UPLOADS_DIR, targetPost.filename);

    if (fs.existsSync(physicalPath)) {
        try {
            fs.unlinkSync(physicalPath);
        } catch (e) {
            console.error("Unlinking failure on static container:", e);
        }
    }

    db.posts.splice(postIdx, 1);
    saveDatabase();
    res.json({ success: true });
});

// Chat Boards: Message Submission Route
app.post('/api/chat/send', (req, res) => {
    const clientIp = req.ip || req.headers['x-forwarded-for'];
    const remainingTime = checkCooldown(clientIp, chatCooldowns);
    if (remainingTime > 0) {
        return res.status(429).json({ error: `Chat rate limited! Please wait ${remainingTime} seconds.` });
    }

    const { board, text, author } = req.body;

    if (!board || !text || !db.boards[board] || db.boards[board].type !== 'chat') {
        return res.status(400).json({ error: "Active communication pipe target is invalid." });
    }

    const cleanText = text.trim().substring(0, 500); // 500 Character Limit
    if (!cleanText) return res.status(400).json({ error: "Unable to process zero-length payloads." });

    if (!db.chatMessages[board]) {
        db.chatMessages[board] = [];
    }

    const messageObj = {
        id: "msg_" + Date.now() + "_" + Math.round(Math.random() * 100000),
        author: author ? author.trim().substring(0, 25) : "Anonymous User",
        text: cleanText,
        timestamp: Date.now()
    };

    db.chatMessages[board].push(messageObj);
    
    // Cap in-memory history to 300 messages per chatroom to limit storage weight
    if (db.chatMessages[board].length > 300) {
        db.chatMessages[board].shift();
    }

    updateCooldown(clientIp, chatCooldowns);
    saveDatabase();
    res.json({ success: true, message: messageObj });
});

// Create Category Board
app.post('/api/boards/create', adminAuth, (req, res) => {
    const { name, title, type } = req.body;
    const cleanKey = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

    if (!cleanKey || !title) {
        return res.status(400).json({ error: "Parameters fail minimal requirements standard checks." });
    }
    if (db.boards[cleanKey]) {
        return res.status(400).json({ error: "Target structural key conflict detected on system registration." });
    }

    const position = Object.keys(db.boards).length + 1;
    db.boards[cleanKey] = {
        title: title.trim(),
        type: type, // 'mixed' | 'images' | 'videos' | 'chat'
        position: position
    };

    if (type === 'chat') {
        db.chatMessages[cleanKey] = [];
    }

    saveDatabase();
    res.json({ success: true });
});

// Rearrange / Reorder Boards
app.post('/api/boards/reorder', adminAuth, (req, res) => {
    const { order } = req.body; // Array of keys in ordered position: ['key1', 'key2']
    if (!Array.isArray(order)) {
        return res.status(400).json({ error: "Order dataset must be a formal array sequence." });
    }

    order.forEach((key, index) => {
        if (db.boards[key]) {
            db.boards[key].position = index + 1;
        }
    });

    saveDatabase();
    res.json({ success: true, message: "Category boards spatial index tracking updated." });
});

// Delete Category Board and All Nested Assets
app.post('/api/boards/delete', adminAuth, (req, res) => {
    const { name } = req.body;

    if (!db.boards[name]) {
        return res.status(404).json({ error: "Registration target element node key match failure." });
    }

    // Delete associated files in uploads
    const postsToDelete = db.posts.filter(p => p.board === name);
    postsToDelete.forEach(post => {
        const filePath = path.join(UPLOADS_DIR, post.filename);
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) {}
        }
    });

    // Delete associated pending items
    const pendToDelete = db.pendingPosts.filter(p => p.board === name);
    pendToDelete.forEach(post => {
        const filePath = path.join(PENDING_DIR, post.filename);
        if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) {}
        }
    });

    // Filter DB registers
    db.posts = db.posts.filter(p => p.board !== name);
    db.pendingPosts = db.pendingPosts.filter(p => p.board !== name);
    if (db.chatMessages[name]) delete db.chatMessages[name];

    delete db.boards[name];

    saveDatabase();
    res.json({ success: true });
});

// Admin Utility: Download Entire Board Collection as a ZIP File
app.get('/api/boards/download', adminAuth, (req, res) => {
    const targetBoard = req.query.board;

    if (!targetBoard || !db.boards[targetBoard]) {
        return res.status(404).json({ error: "Target board not found." });
    }

    const targetPosts = db.posts.filter(p => p.board === targetBoard);
    
    if (targetPosts.length === 0) {
        return res.status(400).json({ error: "This board has no physical files to download." });
    }

    res.attachment(`${targetBoard}-board-export.zip`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
        res.status(500).send({ error: err.message });
    });

    archive.pipe(res);

    targetPosts.forEach(post => {
        const filePath = path.join(UPLOADS_DIR, post.filename);
        if (fs.existsSync(filePath)) {
            archive.file(filePath, { name: post.filename });
        }
    });

    archive.finalize();
});

// Start Server
app.listen(PORT, () => {
    console.log(`System Server active and waiting commands on port: ${PORT}`);
});

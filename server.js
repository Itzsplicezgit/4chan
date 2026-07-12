const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'database.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

let db = {
    boards: {},
    posts: [],
    pendingPosts: [],
    boardOrder: []
};

function loadDatabase() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            db = {
                boards: parsed.boards || {},
                posts: parsed.posts || [],
                pendingPosts: parsed.pendingPosts || [],
                boardOrder: parsed.boardOrder || Object.keys(parsed.boards || {})
            };
            
            Object.keys(db.boards).forEach(key => {
                if (!db.boards[key].messages) {
                    db.boards[key].messages = [];
                }
            });
            
            let changed = false;
            Object.keys(db.boards).forEach(key => {
                if (!db.boardOrder.includes(key)) {
                    db.boardOrder.push(key);
                    changed = true;
                }
            });
            if (changed) saveDatabase();
        } else {
            saveDatabase();
        }
    } catch (e) {
        console.error("Critical: Error balancing state index maps:", e);
    }
}

function saveDatabase() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
        console.error("Critical file write fault dropped on transaction commit:", e);
    }
}

loadDatabase();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOADS_DIR));

const uploadCooldowns = new Map();
const chatCooldowns = new Map();

function cleanOldCooldowns() {
    const now = Date.now();
    for (const [ip, time] of uploadCooldowns.entries()) {
        if (now - time > 60000) uploadCooldowns.delete(ip);
    }
    for (const [ip, time] of chatCooldowns.entries()) {
        if (now - time > 60000) chatCooldowns.delete(ip);
    }
}
setInterval(cleanOldCooldowns, 30000);

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const uploadFilter = (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif|webp|mp4|webm|mov|quicktime/i;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (extname && mimetype) {
        return cb(null, true);
    }
    cb(new Error('Format rejected. Unsupported Media structure type.'));
};

const fileUploaderEngine = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: uploadFilter
});

function checkAdminPassword(req, res, next) {
    const password = req.headers['x-admin-password'];
    if (password === 'your_secure_password_here') {
        return next();
    }
    res.status(401).json({ error: 'System Authentication Failure.' });
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/api/data', (req, res) => {
    const pass = req.headers['x-admin-password'];
    if (pass === 'your_secure_password_here') {
        return res.json(db);
    }
    
    const publicBoards = {};
    db.boardOrder.forEach(key => {
        if (db.boards[key]) {
            publicBoards[key] = {
                title: db.boards[key].title,
                type: db.boards[key].type,
                messages: db.boards[key].type === 'chat' ? db.boards[key].messages : undefined
            };
        }
    });

    res.json({
        boards: publicBoards,
        posts: db.posts,
        boardOrder: db.boardOrder
    });
});

app.post('/api/posts/submit', fileUploaderEngine.array('media', 10), (req, res) => {
    const clientIp = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    
    if (uploadCooldowns.has(clientIp)) {
        const diff = now - uploadCooldowns.get(clientIp);
        if (diff < 60000) {
            if (req.files && req.files.length > 0) {
                req.files.forEach(f => {
                    try { fs.unlinkSync(f.path); } catch (e) {}
                });
            }
            const waitTime = Math.ceil((60000 - diff) / 1000);
            return res.status(429).json({ error: `Upload frequency limit hit. Please wait ${waitTime} seconds before submitting again.` });
        }
    }

    const { board } = req.body;
    if (!board || !db.boards[board]) {
        if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch(e){} });
        return res.status(400).json({ error: 'Target directory tracking context unassigned.' });
    }

    if (db.boards[board].type === 'chat') {
        if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch(e){} });
        return res.status(400).json({ error: 'Cannot submit standard file queue payloads into an active chat module board.' });
    }

    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files provided for evaluation staging.' });
    }

    uploadCooldowns.set(clientIp, now);

    const incomingBatch = [];
    req.files.forEach(file => {
        const id = String(Math.floor(100000 + Math.random() * 900000));
        const isVideo = file.mimetype.startsWith('video/');
        
        incomingBatch.push({
            id,
            board,
            type: isVideo ? 'video' : 'image',
            src: `/uploads/${file.filename}`,
            timestamp: now
        });
    });

    db.pendingPosts.push(...incomingBatch);
    saveDatabase();

    res.json({ success: true, message: `${incomingBatch.length} items pushed to moderation framework.` });
});

app.post('/api/chat/send', (req, res) => {
    const clientIp = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();

    if (chatCooldowns.has(clientIp)) {
        const diff = now - chatCooldowns.get(clientIp);
        if (diff < 60000) {
            const waitTime = Math.ceil((60000 - diff) / 1000);
            return res.status(429).json({ error: `Message rate limit hit. Please wait ${waitTime} seconds.` });
        }
    }

    const { board, text } = req.body;
    if (!board || !db.boards[board] || db.boards[board].type !== 'chat') {
        return res.status(400).json({ error: 'Invalid targeted channel context.' });
    }

    const sanitizedText = String(text || '').trim();
    if (!sanitizedText) {
        return res.status(400).json({ error: 'Cannot transmit empty message parameters.' });
    }

    const wordCount = sanitizedText.split(/\s+/).filter(word => word.length > 0).length;
    if (wordCount > 200) {
        return res.status(400).json({ error: `Message exceeds the strict 200-word limit. Your post contains ${wordCount} words.` });
    }

    chatCooldowns.set(clientIp, now);

    const messagePayload = {
        id: String(Math.floor(100000 + Math.random() * 900000)),
        text: sanitizedText.substring(0, 2000), // Safety string boundary cutoff
        timestamp: now
    };

    if (!db.boards[board].messages) db.boards[board].messages = [];
    db.boards[board].messages.push(messagePayload);
    
    if (db.boards[board].messages.length > 200) {
        db.boards[board].messages.shift();
    }

    saveDatabase();
    res.json({ success: true, message: messagePayload });
});

app.post('/api/posts/upload', checkAdminPassword, fileUploaderEngine.array('media', 50), (req, res) => {
    const { board, customId } = req.body;
    if (!board || !db.boards[board]) {
        if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch(e){} });
        return res.status(400).json({ error: 'Target destination board configuration entry missing.' });
    }

    if (db.boards[board].type === 'chat') {
        if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch(e){} });
        return res.status(400).json({ error: 'Media files cannot be assigned directly into chat board configurations.' });
    }

    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Zero media file array references captured.' });
    }

    const outputFeedback = [];
    const executionWarnings = [];

    req.files.forEach((file, index) => {
        let finalId;
        if (req.files.length === 1 && customId && customId.trim().length > 0) {
            finalId = customId.trim();
        } else {
            finalId = String(Math.floor(100000 + Math.random() * 900000));
        }

        const collisionCheck = db.posts.some(p => p.id === finalId);
        if (collisionCheck) {
            finalId = finalId + '-' + Math.floor(10 + Math.random() * 90);
            executionWarnings.push(`ID overlap detected. Mutated to secondary sequence hash key: ${finalId}`);
        }

        const isVideo = file.mimetype.startsWith('video/');
        const record = {
            id: finalId,
            board,
            type: isVideo ? 'video' : 'image',
            src: `/uploads/${file.filename}`,
            timestamp: Date.now()
        };

        db.posts.push(record);
        outputFeedback.push(record);
    });

    saveDatabase();

    res.json({
        success: true,
        message: `Successfully integrated ${outputFeedback.length} files straight to production distribution nodes.`,
        warnings: executionWarnings.length > 0 ? executionWarnings : undefined
    });
});

app.post('/api/posts/approve', checkAdminPassword, (req, res) => {
    const { id, action } = req.body;
    const matchIndex = db.pendingPosts.findIndex(p => p.id === String(id));

    if (matchIndex === -1) {
        return res.status(404).json({ error: 'Target submission item record could not be checked within active queue.' });
    }

    const assetItem = db.pendingPosts[matchIndex];
    db.pendingPosts.splice(matchIndex, 1);

    if (action === 'approve') {
        db.posts.push(assetItem);
        saveDatabase();
        return res.json({ success: true, message: 'Content track entry added into distributed active index arrays.' });
    } else {
        const relativeFilePath = path.join(__dirname, assetItem.src);
        fs.unlink(relativeFilePath, (err) => {
            if (err) console.error("File system asset drop collision tracking mismatch:", err);
        });
        saveDatabase();
        return res.json({ success: true, message: 'Item rejected. Linked binary media storage file wiped clean.' });
    }
});

app.post('/api/posts/delete', checkAdminPassword, (req, res) => {
    const { id } = req.body;
    const index = db.posts.findIndex(p => p.id === String(id));

    if (index === -1) {
        return res.status(404).json({ error: 'Item record tracking signature not active across known registries.' });
    }

    const targetedPost = db.posts[index];
    db.posts.splice(index, 1);

    const physicalFileRef = path.join(__dirname, targetedPost.src);
    fs.unlink(physicalFileRef, (err) => {
        if (err) console.error("Underlying system file structural cleanup call failure encountered:", err);
    });

    saveDatabase();
    res.json({ success: true, message: 'Post storage trace completely deleted.' });
});

app.post('/api/boards/create', checkAdminPassword, (req, res) => {
    const { name, title, type } = req.body;
    if (!name || !title) return res.status(400).json({ error: 'Parameters failed constraints criteria rules.' });

    const standardHandle = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!standardHandle) return res.status(400).json({ error: 'Alpha-numeric conversion constraints criteria drop error.' });

    if (db.boards[standardHandle]) {
        return res.status(400).json({ error: 'Board directory identifier assignment space already occupied.' });
    }

    const validTypes = ['mixed', 'images', 'videos', 'chat'];
    const chosenType = validTypes.includes(type) ? type : 'mixed';

    db.boards[standardHandle] = {
        title: title.trim(),
        type: chosenType,
        messages: chosenType === 'chat' ? [] : undefined
    };

    if (!db.boardOrder.includes(standardHandle)) {
        db.boardOrder.push(standardHandle);
    }

    saveDatabase();
    res.json({ success: true, message: 'Board allocation layout context bound.' });
});

app.post('/api/boards/delete', checkAdminPassword, (req, res) => {
    const { name } = req.body;
    if (!name || !db.boards[name]) return res.status(404).json({ error: 'Board context unresolvable.' });

    const connectedMediaPosts = db.posts.filter(p => p.board === name);
    db.posts = db.posts.filter(p => p.board !== name);
    db.pendingPosts = db.pendingPosts.filter(p => p.board !== name);

    connectedMediaPosts.forEach(post => {
        const assetLink = path.join(__dirname, post.src);
        fs.unlink(assetLink, (err) => { if (err) console.error("File clear drop tracking error:", err); });
    });

    delete db.boards[name];
    db.boardOrder = db.boardOrder.filter(k => k !== name);

    saveDatabase();
    res.json({ success: true, message: 'Category workspace entry broken down completely.' });
});

app.post('/api/boards/reorder', checkAdminPassword, (req, res) => {
    const { order } = req.body;
    if (!Array.isArray(order)) {
        return res.status(400).json({ error: 'Invalid parameters format structure assigned.' });
    }

    const filteredOrder = order.filter(key => db.boards[key] !== undefined);
    
    Object.keys(db.boards).forEach(key => {
        if (!filteredOrder.includes(key)) {
            filteredOrder.push(key);
        }
    });

    db.boardOrder = filteredOrder;
    saveDatabase();
    res.json({ success: true, message: 'Custom arrangement layer order successfully configured.' });
});

app.get('/api/boards/download-pack', checkAdminPassword, (req, res) => {
    const targetBoard = req.query.board;
    if (!targetBoard || !db.boards[targetBoard]) {
        return res.status(404).json({ error: 'Target partition allocation missing.' });
    }

    const boardConfig = db.boards[targetBoard];
    const matchingPosts = db.posts.filter(p => p.board === targetBoard);

    res.attachment(`${targetBoard}-archive-pack.zip`);
    const archive = archiver('zip', { zlib: { level: 5 } });

    archive.on('error', (err) => {
        res.status(500).send({ error: err.message });
    });

    archive.pipe(res);

    const manifestData = {
        boardKey: targetBoard,
        meta: boardConfig,
        exportedAt: Date.now(),
        contentsCount: matchingPosts.length,
        postsList: matchingPosts
    };

    archive.append(JSON.stringify(manifestData, null, 2), { name: 'manifest-descriptor.json' });

    if (boardConfig.type !== 'chat') {
        matchingPosts.forEach(post => {
            const systemPath = path.join(__dirname, post.src);
            if (fs.existsSync(systemPath)) {
                const baseName = path.basename(systemPath);
                archive.file(systemPath, { name: `media_files/${post.id}-${baseName}` });
            }
        });
    }

    archive.finalize();
});

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: `Upload Engine Constraint: ${err.message}` });
    } else if (err) {
        return res.status(400).json({ error: err.message });
    }
    next();
});

app.listen(PORT, () => {
    console.log(`[DarkChan Engine Running Active] Port Allocation Verified: ${PORT}`);
});

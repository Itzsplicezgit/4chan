const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const ADMIN_PASSWORD = 'password';

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

let db = {
    boards: {
        all: { title: "All Media Feed", type: "mixed" }
    },
    boardOrder: ["all"],
    posts: [],
    pendingPosts: []
};

if (fs.existsSync(DB_FILE)) {
    try {
        const fileData = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        db = { ...db, ...fileData };
        if (!db.boardOrder || !Array.isArray(db.boardOrder)) {
            db.boardOrder = Object.keys(db.boards);
        }
    } catch (e) {
        console.error("Malformed database encountered. Resetting memory registers.", e);
    }
} else {
    saveDatabase();
}

function saveDatabase() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 4), 'utf8');
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 }
});

const uploadCooldowns = {};
const messageCooldowns = {};

function checkUploadCooldown(req, res, next) {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const now = Date.now();
    if (uploadCooldowns[ip] && (now - uploadCooldowns[ip] < 60000)) {
        const remaining = Math.ceil((60000 - (now - uploadCooldowns[ip])) / 1000);
        return res.status(429).json({ success: false, error: `Upload rate limit active. Please wait ${remaining} seconds.` });
    }
    next();
}

function updateUploadCooldown(req) {
    if (req.headers['x-admin-password'] === ADMIN_PASSWORD) return;
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    uploadCooldowns[ip] = Date.now();
}

app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(__dirname));

app.get('/api/data', (req, res) => {
    const isAdmin = req.headers['x-admin-password'] === ADMIN_PASSWORD;
    const clientData = {
        boards: db.boards,
        boardOrder: db.boardOrder,
        posts: db.posts
    };
    if (isAdmin) {
        clientData.pendingPosts = db.pendingPosts;
    }
    res.json(clientData);
});

app.post('/api/posts/submit', checkUploadCooldown, upload.single('media'), (req, res) => {
    const { board } = req.body;
    if (!board || !db.boards[board]) {
        return res.status(400).json({ success: false, error: 'Target submission node invalid.' });
    }
    if (db.boards[board].type === 'chat') {
        return res.status(400).json({ success: false, error: 'File submissions are disabled on chat-only boards.' });
    }
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'File stream resource empty.' });
    }

    const mime = req.file.mimetype;
    let type = 'image';
    if (mime.startsWith('video/')) type = 'video';

    const newPending = {
        id: String(Date.now() + Math.floor(Math.random() * 1000)),
        board: board,
        type: type,
        src: `/uploads/${req.file.filename}`,
        timestamp: Date.now()
    };

    db.pendingPosts.push(newPending);
    saveDatabase();
    updateUploadCooldown(req);

    res.json({ success: true, message: 'Content queued successfully awaiting moderator validation.' });
});

app.post('/api/posts/chat', (req, res) => {
    const { board, message } = req.body;
    if (!board || !db.boards[board] || db.boards[board].type !== 'chat') {
        return res.status(400).json({ success: false, error: 'Invalid or missing target chat workspace.' });
    }
    if (!message || !message.trim()) {
        return res.status(400).json({ success: false, error: 'Message content cannot be blank.' });
    }

    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const now = Date.now();
    if (messageCooldowns[ip] && (now - messageCooldowns[ip] < 60000)) {
        const remaining = Math.ceil((60000 - (now - messageCooldowns[ip])) / 1000);
        return res.status(429).json({ success: false, error: `Chat velocity threshold exceeded. Wait ${remaining} seconds.` });
    }

    const newChatPost = {
        id: String(Date.now() + Math.floor(Math.random() * 1000)),
        board: board,
        type: 'chat',
        message: message.trim().substring(0, 500),
        timestamp: now
    };

    db.posts.push(newChatPost);
    saveDatabase();

    messageCooldowns[ip] = now;
    res.json({ success: true, post: newChatPost });
});

app.post('/api/posts/approve', (req, res) => {
    if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Unauthorized system configuration access reject.' });
    }
    const { id, action } = req.body;
    const itemIndex = db.pendingPosts.findIndex(p => p.id === String(id));

    if (itemIndex === -1) {
        return res.status(404).json({ success: false, error: 'Target reference asset missing from queue registers.' });
    }

    const item = db.pendingPosts[itemIndex];
    db.pendingPosts.splice(itemIndex, 1);

    if (action === 'approve') {
        db.posts.push(item);
    } else {
        const filename = path.basename(item.src);
        const filepath = path.join(UPLOADS_DIR, filename);
        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
        }
    }

    saveDatabase();
    res.json({ success: true });
});

app.post('/api/posts/upload', checkUploadCooldown, (req, res) => {
    if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Access denied.' });
    }

    upload.array('media')(req, res, function (err) {
        if (err) return res.status(400).json({ success: false, error: err.message });

        const { board, customId } = req.body;
        const files = req.files || [];

        if (!board || !db.boards[board]) {
            return res.status(400).json({ success: false, error: 'Target collection destination missing.' });
        }
        if (db.boards[board].type === 'chat') {
            return res.status(400).json({ success: false, error: 'Cannot directly upload media to chat boards.' });
        }
        if (files.length === 0) {
            return res.status(400).json({ success: false, error: 'No media resources processed.' });
        }

        const warnings = [];
        files.forEach((file, index) => {
            const mime = file.mimetype;
            let type = 'image';
            if (mime.startsWith('video/')) type = 'video';

            let finalId = String(Date.now() + Math.floor(Math.random() * 10000) + index);
            if (customId && files.length === 1) {
                const cleanId = customId.trim().replace(/\s+/g, '-');
                const exists = db.posts.some(p => p.id === cleanId);
                if (!exists) finalId = cleanId;
                else warnings.push(`ID constraint collides. Reverted to dynamic hash tracking registration.`);
            }

            db.posts.push({
                id: finalId,
                board: board,
                type: type,
                src: `/uploads/${file.filename}`,
                timestamp: Date.now()
            });
        });

        saveDatabase();
        updateUploadCooldown(req);
        res.json({ success: true, message: 'Bypass live asset injection complete.', warnings });
    });
});

app.post('/api/posts/delete', (req, res) => {
    if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Privilege authorization error.' });
    }
    const { id } = req.body;
    const index = db.posts.findIndex(p => p.id === String(id));

    if (index === -1) {
        return res.status(404).json({ success: false, error: 'Asset target item registration index key not found.' });
    }

    const post = db.posts[index];
    db.posts.splice(index, 1);

    if (post.src) {
        const filename = path.basename(post.src);
        const filepath = path.join(UPLOADS_DIR, filename);
        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
        }
    }

    saveDatabase();
    res.json({ success: true });
});

app.post('/api/boards/create', (req, res) => {
    if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Access denied.' });
    }
    const { name, title, type } = req.body;
    const cleanName = name ? name.trim().toLowerCase().replace(/\s+/g, '') : '';

    if (!cleanName || !title) {
        return res.status(400).json({ success: false, error: 'Invalid configuration parameters supplied.' });
    }
    if (db.boards[cleanName]) {
        return res.status(400).json({ success: false, error: 'Board directory tag already exists.' });
    }

    db.boards[cleanName] = { title: title.trim(), type: type || 'mixed' };
    db.boardOrder.push(cleanName);
    saveDatabase();
    res.json({ success: true });
});

app.post('/api/boards/rearrange', (req, res) => {
    if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Access denied.' });
    }
    const { order } = req.body;
    if (!order || !Array.isArray(order)) {
        return res.status(400).json({ success: false, error: 'Invalid structure matrix tracking dataset.' });
    }

    const validOrder = order.filter(key => db.boards[key]);
    Object.keys(db.boards).forEach(key => {
        if (!validOrder.includes(key)) validOrder.push(key);
    });

    db.boardOrder = validOrder;
    saveDatabase();
    res.json({ success: true, message: 'Custom feed display prioritization rearranged.' });
});

app.get('/api/boards/download', (req, res) => {
    if (req.query.password !== ADMIN_PASSWORD) {
        return res.status(401).send('System credential configuration error validation access reject.');
    }
    const targetBoard = req.query.board;
    if (!targetBoard || !db.boards[targetBoard]) {
        return res.status(404).send('Target system category partition not found.');
    }

    const boardPosts = db.posts.filter(p => p.board === targetBoard || targetBoard === 'all');
    
    res.attachment(`board-${targetBoard}-backup.zip`);
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('error', (err) => { res.status(500).send({ error: err.message }); });
    archive.pipe(res);

    archive.append(JSON.stringify({
        boardDetails: db.boards[targetBoard],
        posts: boardPosts
    }, null, 4), { name: 'metadata.json' });

    boardPosts.forEach(post => {
        if (post.src) {
            const filename = path.basename(post.src);
            const filepath = path.join(UPLOADS_DIR, filename);
            if (fs.existsSync(filepath)) {
                archive.file(filepath, { name: `media/${filename}` });
            }
        }
    });

    archive.finalize();
});

app.post('/api/boards/delete', (req, res) => {
    if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Unauthorized command rejection.' });
    }
    const { name } = req.body;
    if (!name || name === 'all' || !db.boards[name]) {
        return res.status(400).json({ success: false, error: 'Target core protective layer deletion locked.' });
    }

    const targets = db.posts.filter(p => p.board === name);
    targets.forEach(post => {
        if (post.src) {
            const filename = path.basename(post.src);
            const filepath = path.join(UPLOADS_DIR, filename);
            if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
        }
    });

    db.posts = db.posts.filter(p => p.board !== name);
    db.pendingPosts = db.pendingPosts.filter(p => p.board !== name);
    delete db.boards[name];
    db.boardOrder = db.boardOrder.filter(k => k !== name);

    saveDatabase();
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`Server system online running interface processes at port: ${PORT}`);
});

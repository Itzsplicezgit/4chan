const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const MASTER_PASSWORD = process.env.ADMIN_PASSWORD || 'fish';
const DATA_FILE = path.join(__dirname, 'data.json');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const THUMBNAILS_DIR = path.join(__dirname, 'uploads', 'thumbnails');

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(THUMBNAILS_DIR)) {
    fs.mkdirSync(THUMBNAILS_DIR, { recursive: true });
}

const fallbackThumbPath = path.join(THUMBNAILS_DIR, 'video-placeholder.jpg');
if (!fs.existsSync(fallbackThumbPath)) {
    const pixelB64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
    fs.writeFileSync(fallbackThumbPath, Buffer.from(pixelB64, 'base64'));
}

let serverCache = {
    boards: {},
    posts: [],
    pendingPosts: []
};

function seedDefaults() {
    if (Object.keys(serverCache.boards).length === 0) {
        serverCache.boards = {
            main: { title: "Main Lounge", type: "mixed", position: 0 },
            artwork: { title: "Cool Artwork Space", type: "images", position: 1 },
            clips: { title: "Exclusively Videos Feed", type: "videos", position: 2 },
            lobby: { title: "General Chat Lobby", type: "chat", position: 3 }
        };
        saveDatabaseToDisk();
    }
}

function loadDatabaseFromDisk() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const rawData = fs.readFileSync(DATA_FILE, 'utf8');
            serverCache = JSON.parse(rawData);

            if (!serverCache.boards) serverCache.boards = {};
            if (!serverCache.posts) serverCache.posts = [];
            if (!serverCache.pendingPosts) serverCache.pendingPosts = [];

            let index = 0;
            Object.keys(serverCache.boards).forEach(key => {
                if (serverCache.boards[key].position === undefined) {
                    serverCache.boards[key].position = index++;
                }
            });
        } else {
            seedDefaults();
        }
    } catch (error) {
        console.error("System storage error parsing persistent database registry:", error);
    }
}

function saveDatabaseToDisk() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(serverCache, null, 4), 'utf8');
    } catch (error) {
        console.error("Critical failure archiving memory changes to server tracking disk:", error);
    }
}

loadDatabaseFromDisk();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOADS_DIR));

app.get('/admin', (req, res) => {
    const adminPath = path.join(__dirname, 'admin.html');
    if (fs.existsSync(adminPath)) {
        res.sendFile(adminPath);
    } else {
        res.status(404).json({ success: false, error: 'admin.html file not found in root directory.' });
    }
});

app.use(express.static(__dirname));

const rateLimitCooldownRegistry = new Map();

function enforceOperationalCooldown(req, res, next) {
    const userIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const now = Date.now();

    const adminPassHeader = req.headers['x-admin-password'];
    if (adminPassHeader === MASTER_PASSWORD) {
        return next();
    }

    if (rateLimitCooldownRegistry.has(userIp)) {
        const lastExecutionTimestamp = rateLimitCooldownRegistry.get(userIp);
        const timeElapsed = now - lastExecutionTimestamp;

        if (timeElapsed < 60000) {
            const remainingSeconds = Math.ceil((60000 - timeElapsed) / 1000);
            return res.status(429).json({
                success: false,
                error: `Cooldown active. Please wait ${remainingSeconds} second(s) before sending data.`
            });
        }
    }

    req.clientIpToken = userIp;
    next();
}

function verifyAdminCredentials(req, res, next) {
    const token = req.headers['x-admin-password'];
    if (!token || token !== MASTER_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Invalid master system security passphrase.' });
    }
    next();
}

const storageEngine = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const uploadMiddleware = multer({
    storage: storageEngine,
    fileFilter: (req, file, cb) => {
        cb(null, true);
    }
});

app.get('/api/public/data', (req, res) => {
    res.json(serverCache);
});

app.get('/api/public/posts/:board', (req, res) => {
    const board = req.params.board;

    if (!serverCache.boards[board]) {
        return res.status(404).json({ success: false, error: 'Board not found.' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;

    const allPosts = serverCache.posts
        .filter(p => p.board === board)
        .sort((a, b) => b.timestamp - a.timestamp);

    const total = allPosts.length;
    const totalPages = Math.ceil(total / limit);

    const start = (page - 1) * limit;
    const end = start + limit;

    const paginated = allPosts.slice(start, end);

    res.json({
        success: true,
        board,
        page,
        limit,
        total,
        totalPages,
        posts: paginated
    });
});

app.get('/api/data', verifyAdminCredentials, (req, res) => {
    res.json(serverCache);
});

app.post('/api/boards/create', verifyAdminCredentials, (req, res) => {
    const { name, title, type } = req.body;

    if (!name || !title || !type) {
        return res.status(400).json({ success: false, error: 'Missing core board parameters.' });
    }

    const cleanKey = name.trim().toLowerCase().replace(/\s+/g, '');
    if (serverCache.boards[cleanKey]) {
        return res.status(400).json({ success: false, error: 'Unique board handle conflict detected.' });
    }

    const currentBoardCount = Object.keys(serverCache.boards).length;

    serverCache.boards[cleanKey] = {
        title: title.trim(),
        type: type,
        position: currentBoardCount
    };

    saveDatabaseToDisk();
    res.json({ success: true, message: 'Category board deployed successfully!' });
});

app.post('/api/boards/delete', verifyAdminCredentials, (req, res) => {
    const { name } = req.body;

    if (!name || !serverCache.boards[name]) {
        return res.status(404).json({ success: false, error: 'Target board configuration layer missing.' });
    }

    serverCache.posts = serverCache.posts.filter(p => p.board !== name);
    serverCache.pendingPosts = serverCache.pendingPosts.filter(p => p.board !== name);

    delete serverCache.boards[name];

    let index = 0;
    Object.keys(serverCache.boards)
        .sort((a, b) => serverCache.boards[a].position - serverCache.boards[b].position)
        .forEach(key => {
            serverCache.boards[key].position = index++;
        });

    saveDatabaseToDisk();
    res.json({ success: true, message: 'Board category tracking dropped cleanly.' });
});

app.post('/api/boards/reorder', verifyAdminCredentials, (req, res) => {
    const { order } = req.body;

    if (!Array.isArray(order)) {
        return res.status(400).json({ success: false, error: 'Invalid tracking array layout specification.' });
    }

    let processedCount = 0;
    order.forEach((boardKey, index) => {
        if (serverCache.boards[boardKey]) {
            serverCache.boards[boardKey].position = index;
            processedCount++;
        }
    });

    if (processedCount === 0) {
        return res.status(400).json({ success: false, error: 'No valid structural handles updated.' });
    }

    saveDatabaseToDisk();
    res.json({ success: true, message: 'Custom layout positions logged successfully!' });
});

app.post('/api/posts/approve', verifyAdminCredentials, (req, res) => {
    const { id, action } = req.body;
    const postStringId = String(id);

    const targetIndex = serverCache.pendingPosts.findIndex(p => String(p.id) === postStringId);
    if (targetIndex === -1) {
        return res.status(404).json({ success: false, error: 'Target queue item tracker expired.' });
    }

    const matchingPost = serverCache.pendingPosts[targetIndex];
    serverCache.pendingPosts.splice(targetIndex, 1);

    if (action === 'approve') {
        serverCache.posts.push(matchingPost);
        res.json({ success: true, message: 'Item verification accepted into live feed.' });
    } else {
        if (matchingPost.src) {
            const rawPath = path.join(__dirname, matchingPost.src);
            if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
        }
        res.json({ success: true, message: 'Submission flagged and dropped from workspace.' });
    }

    saveDatabaseToDisk();
});

app.post('/api/posts/delete', verifyAdminCredentials, (req, res) => {
    const { id } = req.body;
    const postStringId = String(id);

    const targetIndex = serverCache.posts.findIndex(p => String(p.id) === postStringId);
    if (targetIndex === -1) {
        return res.status(404).json({ success: false, error: 'Post record registry not tracked on system.' });
    }

    const archivedItem = serverCache.posts[targetIndex];
    serverCache.posts.splice(targetIndex, 1);

    if (archivedItem.src) {
        const diskPath = path.join(__dirname, archivedItem.src);
        if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
    }

    saveDatabaseToDisk();
    res.json({ success: true, message: 'Asset fully stripped from media structures.' });
});

app.post('/api/posts/upload', enforceOperationalCooldown, uploadMiddleware.array('media'), (req, res) => {
    const { board, customId } = req.body;

    if (!board || !serverCache.boards[board]) {
        return res.status(400).json({ success: false, error: 'Target board parameters missing or corrupted.' });
    }

    const targetBoardMeta = serverCache.boards[board];

    if (targetBoardMeta.type === 'chat') {
        if (req.files && req.files.length > 0) {
            req.files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
        }
        return res.status(400).json({ success: false, error: 'Media asset submission blocked: File uploading disabled in chat threads.' });
    }

    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, error: 'Missing core upload data files.' });
    }

    const isSessionAdmin = (req.headers['x-admin-password'] === MASTER_PASSWORD);
    const addedItems = [];

    for (let i = 0; i < req.files.length; i++) {
        const currentFile = req.files[i];
        const assignedPostId = (customId && i === 0) ? String(customId).trim() : String(Date.now() + i + Math.round(Math.random() * 1000));

        let determinedType = 'image';
        if (currentFile.mimetype.startsWith('video/')) {
            determinedType = 'video';
        }

        const relativeSourceUrl = `/uploads/${currentFile.filename}`;

        let relativeThumbnailUrl = relativeSourceUrl;
        if (determinedType === 'video') {
            relativeThumbnailUrl = `/uploads/thumbnails/video-placeholder.jpg`;
        }

        const generatedPostNode = {
            id: assignedPostId,
            board: board,
            type: determinedType,
            src: relativeSourceUrl,
            thumbnail: relativeThumbnailUrl,
            timestamp: Date.now()
        };

        if (isSessionAdmin) {
            serverCache.posts.push(generatedPostNode);
        } else {
            serverCache.pendingPosts.push(generatedPostNode);
        }

        addedItems.push(generatedPostNode);
    }

    if (!isSessionAdmin && req.clientIpToken) {
        rateLimitCooldownRegistry.set(req.clientIpToken, Date.now());
    }

    saveDatabaseToDisk();

    res.json({
        success: true,
        message: isSessionAdmin ? 'Direct bypass upload succeeded!' : 'Content submitted successfully to system queue pending review.',
        items: addedItems
    });
});

app.post('/api/posts/chat', enforceOperationalCooldown, (req, res) => {
    const { board, message, customId } = req.body;

    if (!board || !serverCache.boards[board]) {
        return res.status(400).json({ success: false, error: 'Target destination room invalid.' });
    }

    const targetBoardMeta = serverCache.boards[board];
    if (targetBoardMeta.type !== 'chat') {
        return res.status(400).json({ success: false, error: 'Action execution blocked: Destination is not a designated chat interface.' });
    }

    if (!message || String(message).trim().length === 0) {
        return res.status(400).json({ success: false, error: 'Cannot broadcast an empty message block.' });
    }

    const absoluteWordCount = message.trim().split(/\s+/).filter(Boolean).length;
    if (absoluteWordCount > 200) {
        return res.status(400).json({ success: false, error: `Content limit exceeded. Your submission contains ${absoluteWordCount} words (Maximum limit configuration size: 200 words).` });
    }

    const isSessionAdmin = (req.headers['x-admin-password'] === MASTER_PASSWORD);
    const assignedPostId = customId ? String(customId).trim() : String(Date.now() + Math.round(Math.random() * 1000));

    const processedChatPayload = {
        id: assignedPostId,
        board: board,
        type: 'text',
        message: message.trim(),
        timestamp: Date.now()
    };

    serverCache.posts.push(processedChatPayload);

    if (!isSessionAdmin && req.clientIpToken) {
        rateLimitCooldownRegistry.set(req.clientIpToken, Date.now());
    }

    saveDatabaseToDisk();
    res.json({ success: true, message: 'Message logged to stream room context.', post: processedChatPayload });
});

app.get('/api/boards/download/:name', verifyAdminCredentials, (req, res) => {
    const targetBoardHandle = req.params.name;

    if (!serverCache.boards[targetBoardHandle]) {
        return res.status(404).json({ success: false, error: 'Target tracking database entry does not exist.' });
    }

    const combinedSystemAssets = [...serverCache.posts, ...serverCache.pendingPosts]
        .filter(p => p.board === targetBoardHandle && p.src);

    if (combinedSystemAssets.length === 0) {
        return res.status(400).json({ success: false, error: 'No media content assets present to compress on chosen board category.' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=darkchan-board-${targetBoardHandle}-export.zip`);

    const archivalStream = archiver('zip', { zlib: { level: 6 } });

    archivalStream.on('error', (err) => {
        console.error("Internal compression stream mapping error encountered:", err);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: 'Archival routine failure constructing distribution package.' });
        }
    });

    archivalStream.pipe(res);

    combinedSystemAssets.forEach(assetNode => {
        const clearLocalFileName = path.basename(assetNode.src);
        const resolvedLocalDiskFilePath = path.join(UPLOADS_DIR, clearLocalFileName);

        if (fs.existsSync(resolvedLocalDiskFilePath)) {
            archivalStream.file(resolvedLocalDiskFilePath, { name: clearLocalFileName });
        }
    });

    archivalStream.finalize();
});

app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Requested DarkChan backend data pipeline node does not exist.' });
});

app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(` DarkChan Core Server Backend Pipeline Engaged Active `);
    console.log(` System operational loop running securely on port: ${PORT} `);
    console.log(`=======================================================`);
});

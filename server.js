const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
const DB_FILE = path.join(__dirname, 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure database and upload directory exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ boards: {}, posts: [] }, null, 2));
}

// Express Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

// Storage configuration for Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Helper to read/write database state
const readDB = () => JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const writeDB = (data) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

// Auth Middleware
const requireAuth = (req, res, next) => {
    const password = req.headers['x-admin-password'] || req.body.password;
    if (password === 'fish') {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized: Invalid Password' });
    }
};

/* --- Public API Routes --- */

// Get all structural data
app.get('/api/data', (req, res) => {
    res.json(readDB());
});

/* --- Admin Protected API Routes --- */

// Create Board
app.post('/api/boards/create', requireAuth, (req, res) => {
    const { name, title, type } = req.body;
    if (!name || !title || !type) return res.status(400).json({ error: 'Missing fields' });
    
    const db = readDB();
    if (db.boards[name]) return res.status(400).json({ error: 'Board already exists' });
    
    db.boards[name] = { title, type };
    writeDB(db);
    res.json({ success: true });
});

// Delete Board
app.post('/api/boards/delete', requireAuth, (req, res) => {
    const { name } = req.body;
    const db = readDB();
    
    if (db.boards[name]) {
        delete db.boards[name];
        // Orphan clean-up: clear out associated posts
        db.posts = db.posts.filter(post => post.board !== name);
        writeDB(db);
    }
    res.json({ success: true });
});

// Upload Content to a Board
app.post('/api/posts/upload', requireAuth, upload.single('media'), (req, res) => {
    const { board, customId } = req.body;
    if (!board || !req.file) return res.status(400).json({ error: 'Missing core upload assets' });

    const db = readDB();
    const postId = customId.trim() || String(Math.floor(100000 + Math.random() * 900000));

    // Prevent duplicate IDs
    if (db.posts.some(p => p.id === postId)) {
        return res.status(400).json({ error: 'Post ID already exists.' });
    }

    const fileExt = path.extname(req.file.filename).toLowerCase();
    const isVideo = ['.mp4', '.webm', '.ogg', '.mov'].includes(fileExt);
    const type = isVideo ? 'video' : 'image';

    const newPost = {
        id: postId,
        board: board,
        src: `uploads/${req.file.filename}`,
        type: type
    };

    db.posts.push(newPost);
    writeDB(db);
    res.json({ success: true });
});

// Delete Content Item
app.post('/api/posts/delete', requireAuth, (req, res) => {
    const { id } = req.body;
    const db = readDB();
    const postIndex = db.posts.findIndex(p => p.id === id);

    if (postIndex !== -1) {
        const post = db.posts[postIndex];
        const filePath = path.join(__dirname, post.src);
        
        // Remove file from storage disk safely
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        
        db.posts.splice(postIndex, 1);
        writeDB(db);
        return res.json({ success: true });
    }
    res.status(404).json({ error: 'Post ID not found' });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

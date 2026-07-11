const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000; // Updated for production Render binding
const DB_FILE = path.join(__dirname, 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure database and upload directory exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ boards: {}, posts: [], pendingPosts: [] }, null, 2));
} else {
    // Migration: ensure pendingPosts array exists in old files
    try {
        const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (!db.pendingPosts) {
            db.pendingPosts = [];
            fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        }
    } catch (e) {
        console.error("Database migration check failed:", e);
    }
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

// Separate instances: one unrestricted for admins, one size-capped for public users
const adminUpload = multer({ storage: storage });
const userUpload = multer({ 
    storage: storage,
    limits: { fileSize: 20 * 1024 * 1024 } // Cap public uploads at exactly 20MB per file
});

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

// Public Route: Users upload files to a board for approval queue (with 20MB single-file ceiling)
app.post('/api/posts/submit', (req, res, next) => {
    userUpload.array('media')(req, res, (err) => {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large! User uploads are strictly limited to a maximum of 20MB per asset.' });
        } else if (err) {
            return res.status(400).json({ error: 'An error occurred processing your file upload structure.' });
        }
        next();
    });
}, (req, res) => {
    const { board } = req.body;
    if (!board || !req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Missing core upload assets' });
    }

    const db = readDB();
    const addedSubmissions = [];

    req.files.forEach((file) => {
        const postId = String(Math.floor(100000 + Math.random() * 900000));
        const fileExt = path.extname(file.filename).toLowerCase();
        const isVideo = ['.mp4', '.webm', '.ogg', '.mov'].includes(fileExt);
        const type = isVideo ? 'video' : 'image';

        const newSubmission = {
            id: postId,
            board: board,
            src: `uploads/${file.filename}`,
            type: type
        };

        db.pendingPosts.push(newSubmission);
        addedSubmissions.push(newSubmission);
    });

    writeDB(db);

    res.json({ 
        success: true, 
        message: `Successfully submitted ${addedSubmissions.length} file(s) for admin approval.`
    });
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
        
        // Remove associated files from disk before clearing references
        const postsToRemove = db.posts.filter(post => post.board === name);
        postsToRemove.forEach(post => {
            const filePath = path.join(__dirname, post.src);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        });

        // Clear references from pending queue as well if a board is deleted
        const pendingToRemove = db.pendingPosts.filter(post => post.board === name);
        pendingToRemove.forEach(post => {
            const filePath = path.join(__dirname, post.src);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        });

        // Orphan clean-up: clear out associated posts from json array
        db.posts = db.posts.filter(post => post.board !== name);
        db.pendingPosts = db.pendingPosts.filter(post => post.board !== name);
        writeDB(db);
    }
    res.json({ success: true });
});

// Admin Route: Direct upload bypassing the approval queue (Unrestricted size limit)
app.post('/api/posts/upload', requireAuth, adminUpload.array('media'), (req, res) => {
    const { board, customId } = req.body;
    if (!board || !req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'Missing core upload assets' });
    }

    const db = readDB();
    const errors = [];
    const addedPosts = [];

    req.files.forEach((file, index) => {
        let postId = customId ? customId.trim() : '';
        
        if (!postId) {
            postId = String(Math.floor(100000 + Math.random() * 900000));
        } else if (req.files.length > 1) {
            postId = `${postId}-${index + 1}`;
        }

        // Prevent duplicate IDs across active and pending posts
        if (db.posts.some(p => p.id === postId) || db.pendingPosts.some(p => p.id === postId)) {
            errors.push(`Post ID ${postId} already exists. Skipping file: ${file.originalname}`);
            const filePath = path.join(__dirname, 'uploads', file.filename);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            return;
        }

        const fileExt = path.extname(file.filename).toLowerCase();
        const isVideo = ['.mp4', '.webm', '.ogg', '.mov'].includes(fileExt);
        const type = isVideo ? 'video' : 'image';

        const newPost = {
            id: postId,
            board: board,
            src: `uploads/${file.filename}`,
            type: type
        };

        db.posts.push(newPost);
        addedPosts.push(newPost);
    });

    writeDB(db);

    if (errors.length > 0 && addedPosts.length === 0) {
        return res.status(400).json({ error: errors.join('\n') });
    }

    res.json({ 
        success: true, 
        message: `Successfully uploaded ${addedPosts.length} file(s).`,
        warnings: errors.length > 0 ? errors : undefined
    });
});

// Admin Route: Process Action on Pending Item (Approve / Reject)
app.post('/api/posts/approve', requireAuth, (req, res) => {
    const { id, action } = req.body; // action can be 'approve' or 'reject'
    const db = readDB();
    const pendingIndex = db.pendingPosts.findIndex(p => p.id === String(id).trim());

    if (pendingIndex === -1) {
        return res.status(404).json({ error: 'Pending submission ID not found' });
    }

    const post = db.pendingPosts[pendingIndex];

    if (action === 'approve') {
        // Enforce unique ID safety switch
        if (db.posts.some(p => p.id === post.id)) {
            post.id = String(Math.floor(100000 + Math.random() * 900000));
        }
        db.posts.push(post);
        db.pendingPosts.splice(pendingIndex, 1);
    } else if (action === 'reject') {
        const filePath = path.join(__dirname, post.src);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        db.pendingPosts.splice(pendingIndex, 1);
    } else {
        return res.status(400).json({ error: 'Invalid process parameters.' });
    }

    writeDB(db);
    res.json({ success: true, action: action });
});

// Delete Live Content Item
app.post('/api/posts/delete', requireAuth, (req, res) => {
    const { id } = req.body;
    const db = readDB();
    const postIndex = db.posts.findIndex(p => p.id === String(id).trim());

    if (postIndex !== -1) {
        const post = db.posts[postIndex];
        const filePath = path.join(__dirname, post.src);
        
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

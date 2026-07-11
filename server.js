const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Master Admin Password configuration
const ADMIN_PASSWORD = 'fish';

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Ensure storage paths exist
const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR);
}

// In-memory structural database fallback state
let db = {
    boards: {},
    posts: [],
    pendingPosts: []
};

// Load existing data on startup
if (fs.existsSync(DATA_FILE)) {
    try {
        db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        // Safety initialization checks
        if (!db.boards) db.boards = {};
        if (!db.posts) db.posts = [];
        if (!db.pendingPosts) db.pendingPosts = [];
    } catch (e) {
        console.error("Error loading data file, using fresh state:", e);
    }
}

function saveDatabase() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// Storage setup for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Helper to determine media file category
function getMediaType(filename) {
    const ext = path.extname(filename).toLowerCase();
    if (['.mp4', '.webm', '.ogg', '.mov'].includes(ext)) {
        return 'video';
    }
    return 'image';
}

// ================= ADMIN VALIDATION MIDDLEWARE =================
function requireAdminAuth(req, res, next) {
    // Check both standard body parameters and explicit request headers
    const providedPassword = req.headers['x-admin-password'] || req.body.password;
    
    if (!providedPassword || providedPassword !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid master system password.' });
    }
    next();
}

// ================= PUBLIC ROUTES =================

// Public data fetch route (Strips pending post details from unauthenticated public feeds)
app.get('/api/public/data', (req, res) => {
    res.json({
        boards: db.boards,
        posts: db.posts
    });
});

// User Public Submission Route
app.post('/api/public/upload', upload.single('media'), (req, res) => {
    const { board } = req.body;
    if (!board || !db.boards[board]) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ success: false, error: 'Target board category does not exist.' });
    }
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No media file asset provided.' });
    }

    const newPending = {
        id: String(Date.now()),
        board: board,
        src: `/uploads/${req.file.filename}`,
        type: getMediaType(req.file.filename)
    };

    db.pendingPosts.push(newPending);
    saveDatabase();

    res.json({ success: true, message: 'Submission uploaded successfully and is awaiting admin approval.' });
});


// ================= AUTHENTICATED ADMIN ROUTES =================

// Secured master database fetch route
app.get('/api/data', requireAdminAuth, (req, res) => {
    res.json(db);
});

// Queue Process Handler (Approve / Reject Action)
app.post('/api/posts/approve', requireAdminAuth, (req, res) => {
    const { id, action } = req.body;
    
    const itemIndex = db.pendingPosts.findIndex(p => p.id === String(id));
    if (itemIndex === -1) {
        return res.status(404).json({ success: false, error: 'Target submission item not found inside the queue.' });
    }

    const targetItem = db.pendingPosts[itemIndex];

    // Remove item completely from the pending queue array
    db.pendingPosts.splice(itemIndex, 1);

    if (action === 'approve') {
        // Transfer historical item directly into the live display list
        db.posts.push(targetItem);
        saveDatabase();
        return res.json({ success: true, message: 'Item approved and deployed to live feed.' });
    } else {
        // Action is rejection: wipe file tracking off storage systems
        const absolutePath = path.join(__dirname, targetItem.src);
        if (fs.existsSync(absolutePath)) {
            fs.unlinkSync(absolutePath);
        }
        saveDatabase();
        return res.json({ success: true, message: 'Submission rejected and file deleted from storage.' });
    }
});

// Deploy Board Category
app.post('/api/boards/create', requireAdminAuth, (req, res) => {
    const { name, title, type } = req.body;
    const cleanName = name.trim().toLowerCase().replace(/\s+/g, '');

    if (!cleanName || !title) {
        return res.status(400).json({ success: false, error: 'Missing required configuration parameters.' });
    }
    if (db.boards[cleanName]) {
        return res.status(400).json({ success: false, error: 'A board with that handle name already exists.' });
    }

    db.boards[cleanName] = {
        title: title,
        type: type || 'mixed'
    };
    saveDatabase();

    res.json({ success: true, message: 'New asset board category successfully created.' });
});

// Decommission Board Category
app.post('/api/boards/delete', requireAdminAuth, (req, res) => {
    const { name } = req.body;

    if (!name || !db.boards[name]) {
        return res.status(400).json({ success: false, error: 'Target destination board does not exist.' });
    }

    // Erase all live posts associated with this board, cleaning up physical files
    const remainingPosts = [];
    db.posts.forEach(post => {
        if (post.board === name) {
            const filePath = path.join(__dirname, post.src);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } else {
            remainingPosts.push(post);
        }
    });
    db.posts = remainingPosts;

    // Erase all pending items associated with this board, cleaning up physical files
    const remainingPending = [];
    db.pendingPosts.forEach(post => {
        if (post.board === name) {
            const filePath = path.join(__dirname, post.src);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } else {
            remainingPending.push(post);
        }
    });
    db.pendingPosts = remainingPending;

    // Drop tracking reference record object completely
    delete db.boards[name];
    saveDatabase();

    res.json({ success: true, message: 'Board category and all containing files deleted.' });
});

// Direct Fast Upload Bypass Route (Supports multiple files simultaneously)
app.post('/api/posts/upload', requireAdminAuth, upload.array('media'), (req, res) => {
    const { board, customId } = req.body;

    if (!board || !db.boards[board]) {
        if (req.files) req.files.forEach(f => fs.unlinkSync(f.path));
        return res.status(400).json({ success: false, error: 'Target collection board handle does not exist.' });
    }
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, error: 'No files were provided for processing.' });
    }

    const totalUploaded = req.files.length;
    const warnings = [];

    req.files.forEach((file, index) => {
        // If a custom ID is provided, use it for the first file only; generate unique ones otherwise
        const definitiveId = (customId && index === 0) ? String(customId) : String(Date.now() + index + Math.floor(Math.random() * 100));

        // Check for duplicates inside the live tracking space
        const duplicateCheck = db.posts.some(p => p.id === definitiveId);
        if (duplicateCheck) {
            warnings.push(`File "${file.originalname}" skipped because ID "${definitiveId}" is already taken.`);
            fs.unlinkSync(file.path);
            return;
        }

        db.posts.push({
            id: definitiveId,
            board: board,
            src: `/uploads/${file.filename}`,
            type: getMediaType(file.filename)
        });
    });

    saveDatabase();

    res.json({
        success: true,
        message: `Successfully processed and published ${totalUploaded - warnings.length} item(s) direct to feed.`,
        warnings: warnings.length > 0 ? warnings : null
    });
});

// Wipe Active Item From Server Live Lists Entirely
app.post('/api/posts/delete', requireAdminAuth, (req, res) => {
    const { id } = req.body;

    const itemIndex = db.posts.findIndex(p => p.id === String(id));
    if (itemIndex === -1) {
        return res.status(404).json({ success: false, error: 'Post ID string not found in database records.' });
    }

    const targetPost = db.posts[itemIndex];
    
    // Wipe track file structure references off the operating disk
    const absolutePath = path.join(__dirname, targetPost.src);
    if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath);
    }

    db.posts.splice(itemIndex, 1);
    saveDatabase();

    res.json({ success: true, message: 'Post dropped off global track listings.' });
});

app.listen(PORT, () => {
    console.log(`Server executing live processes seamlessly at port http://localhost:${PORT}`);
});

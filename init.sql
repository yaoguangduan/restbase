-- RestBase 初始化 SQL —— 开发/测试种子数据
-- users 表由服务器 ensureAuthTable() 自动创建，此处只插入初始用户

INSERT INTO "users" ("username", "password")
VALUES ('admin', 'admin');

-- ═══════ products 表（含 owner 字段，租户隔离） ═══════

CREATE TABLE IF NOT EXISTS "products"
(
    "id"          INTEGER PRIMARY KEY AUTOINCREMENT,
    "name"        TEXT NOT NULL,
    "category"    TEXT,
    "price"       REAL NOT NULL,
    "stock"       INTEGER DEFAULT 0,
    "rating"      REAL    DEFAULT 0,
    "is_active"   INTEGER DEFAULT 1,
    "tags"        TEXT,
    "description" TEXT,
    "created_at"  TEXT,
    "owner"       INTEGER
);

INSERT INTO "products" ("name", "category", "price", "stock", "rating", "is_active", "tags", "description", "created_at", "owner")
VALUES ('Pro Laptop X1', 'Electronics', 999.99, 50, 4.5, 1, '["electronics","gadget"]', 'High-end laptop with 16GB RAM', '2025-06-15T10:00:00Z', 1),
       ('Pro Phone Z', 'Electronics', 699.50, 120, 4.2, 1, '["electronics","phone"]', 'Flagship smartphone', '2025-07-20T08:30:00Z', 1),
       ('Smart Speaker', 'Electronics', 149.99, 300, 3.8, 1, '["electronics","audio"]', 'Voice-controlled speaker', '2025-08-01T14:00:00Z', 1),
       ('Budget Earbuds', 'Electronics', 29.99, 500, 2.0, 1, NULL, 'Basic wireless earbuds', '2025-09-10T09:00:00Z', 1),
       ('Pro Camera Lens', 'Electronics', 549.00, 8, 4.8, 1, '["photography"]', '50mm prime lens', '2025-03-25T12:00:00Z', 1),
       ('Old Radio', 'Electronics', 15.00, 3, 1.5, 0, NULL, 'Vintage AM/FM radio', '2024-12-01T16:00:00Z', 1),
       ('Learn SQL', 'Books', 45.99, 200, 4.0, 1, '["tech","database"]', 'Complete SQL tutorial', '2025-05-10T10:00:00Z', 1),
       ('Pro Algorithms', 'Books', 89.90, 75, 4.6, 1, '["tech","algorithms"]', 'Algorithm design handbook', '2025-04-18T11:00:00Z', 1),
       ('Fiction Novel', 'Books', 12.50, 350, 3.2, 1, '["fiction"]', 'Bestselling fiction', '2025-01-20T15:00:00Z', 1),
       ('Rare Cookbook', 'Books', 550.00, 5, 1.8, 0, NULL, 'Collectors edition cookbook', '2024-11-15T08:00:00Z', 1),
       ('Advanced Math', 'Books', 120.00, 60, 3.5, 1, '["education"]', 'University-level mathematics', '2025-02-28T13:00:00Z', 1),
       ('History 101', 'Books', 250.00, 220, 4.1, 1, '["education","history"]', 'World history overview', '2025-07-05T09:00:00Z', 1),
       ('Robot Kit', 'Toys', 199.99, 45, 4.3, 1, '["toys","stem"]', 'Build-your-own robot', '2025-06-20T10:00:00Z', 1),
       ('Puzzle Box', 'Toys', 24.99, 400, 3.0, 1, '["toys","puzzle"]', 'Wooden puzzle box', '2025-08-12T14:00:00Z', 1),
       ('Pro Race Car', 'Toys', 89.00, 30, 2.0, 0, '["toys","remote"]', 'Remote control race car', '2025-03-10T16:00:00Z', 1),
       ('Building Blocks', 'Toys', 39.99, 250, 4.7, 1, '["toys","building"]', '500-piece building set', '2025-09-01T11:00:00Z', 1),
       ('Yoga Mat', 'Sports', 35.00, 500, 4.0, 1, '["fitness"]', 'Non-slip yoga mat', '2025-05-15T07:00:00Z', 1),
       ('Tennis Racket', 'Sports', 180.00, 80, 3.9, 1, '["tennis"]', 'Professional tennis racket', '2025-04-20T10:00:00Z', 1),
       ('Pro Running Shoes', 'Sports', 920.00, 15, 4.9, 1, '["running"]', 'Carbon-plated running shoes', '2025-07-01T08:00:00Z', 1),
       ('Dumbbells Set', 'Sports', 299.00, 210, 4.4, 1, NULL, 'Adjustable dumbbell pair', '2025-02-10T12:00:00Z', 1),
       ('Winter Jacket', 'Clothing', 189.99, 100, 3.7, 1, '["winter"]', 'Down-filled winter jacket', '2025-10-05T09:00:00Z', 1),
       ('Cotton T-Shirt', 'Clothing', 19.99, 600, 4.0, 1, '["casual"]', 'Organic cotton tee', '2025-08-20T11:00:00Z', 1),
       ('Silk Scarf', 'Clothing', 75.00, 40, 3.5, 0, NULL, 'Hand-woven silk scarf', '2025-01-10T14:00:00Z', 1),
       ('Organic Apples', 'Food', 8.99, 1000, 4.2, 1, '["organic","fruit"]', 'Fresh organic apples 1kg', '2025-09-15T06:00:00Z', 1),
       ('Gourmet Chocolate', 'Food', 45.50, 200, 4.8, 1, '["sweet"]', 'Belgian dark chocolate', '2025-06-30T15:00:00Z', 1),
       ('Coffee Beans', 'Food', 32.00, 300, 4.5, 1, '["beverage"]', 'Single-origin arabica beans', '2025-07-25T08:00:00Z', 1),
       ('Garden Hose', 'Garden', 42.99, 150, 3.0, 1, '["garden","tools"]', '30m expandable hose', '2025-04-05T10:00:00Z', 1),
       ('Flower Pot', 'Garden', 15.99, 280, 3.8, 1, NULL, 'Ceramic flower pot', '2025-03-15T13:00:00Z', 1),
       ('Plant Seeds', 'Garden', 5.99, 500, 4.1, 1, '["garden","seeds"]', 'Mixed wildflower seeds', '2025-02-20T09:00:00Z', 1),
       ('Desk Lamp', 'Home', 65.00, 90, 3.6, 1, '["home","lighting"]', 'LED desk lamp with dimmer', '2025-05-20T11:00:00Z', 1);

-- ═══════ logs 表（全局，无 owner 字段） ═══════

CREATE TABLE IF NOT EXISTS "logs"
(
    "id"          INTEGER PRIMARY KEY AUTOINCREMENT,
    "level"       TEXT NOT NULL,
    "module"      TEXT,
    "message"     TEXT,
    "ip"          TEXT,
    "ua"          TEXT,
    "duration_ms" INTEGER,
    "created_at"  TEXT
);

INSERT INTO "logs" ("level", "module", "message", "ip", "ua", "duration_ms", "created_at")
VALUES ('INFO', 'auth', 'User admin logged in', '192.168.1.10', 'Chrome/120.0', 12, '2025-06-01T08:00:00Z'),
       ('ERROR', 'db', 'Connection pool exhausted', '192.168.1.20', 'Bun/1.0', 5000, '2025-06-02T09:15:00Z'),
       ('WARN', 'server', 'High memory usage detected', '192.168.1.30', 'Bun/1.0', 200, '2025-06-03T10:30:00Z'),
       ('DEBUG', 'query', 'Slow query on products table', '192.168.1.40', 'Bun/1.0', 3200, '2025-06-04T11:45:00Z'),
       ('INFO', 'crud', 'Record created in products', '192.168.1.50', 'Firefox/115.0', 8, '2025-06-05T12:00:00Z'),
       ('ERROR', 'auth', 'Failed login attempt for root', '10.0.0.1', 'curl/8.0', 25, '2025-06-06T13:15:00Z'),
       ('INFO', 'server', 'Server started on port 3333', '127.0.0.1', 'Bun/1.0', 0, '2025-06-07T07:00:00Z'),
       ('WARN', 'db', 'Lock contention on users', '192.168.1.60', 'Bun/1.0', 800, '2025-06-08T14:30:00Z'),
       ('DEBUG', 'middleware', 'Request processed', '192.168.2.10', 'Safari/17.0', 15, '2025-06-09T15:45:00Z'),
       ('INFO', 'auth', 'Password changed for admin', '192.168.1.10', 'Chrome/120.0', 30, '2025-06-10T08:20:00Z'),
       ('ERROR', 'crud', 'Constraint violation on logs', '192.168.1.70', 'Bun/1.0', 50, '2025-06-11T09:00:00Z'),
       ('WARN', 'query', 'Missing index on category', '192.168.1.80', 'Bun/1.0', 1500, '2025-06-12T10:00:00Z'),
       ('DEBUG', 'server', 'GC triggered', '127.0.0.1', 'Bun/1.0', 5, '2025-06-13T11:00:00Z'),
       ('INFO', 'db', 'Migration complete v2', '192.168.1.90', 'Bun/1.0', 400, '2025-06-14T12:00:00Z'),
       ('ERROR', 'server', 'Out of memory warning', '127.0.0.1', 'Bun/1.0', 0, '2025-06-15T13:00:00Z'),
       ('WARN', 'auth', 'Token near expiry for user 1', '192.168.3.10', 'Edge/118.0', 10, '2025-06-16T14:00:00Z'),
       ('DEBUG', 'crud', 'Batch insert of 50 rows', '192.168.1.100', 'Bun/1.0', 250, '2025-06-17T15:00:00Z'),
       ('INFO', 'middleware', 'Rate limit hit for 10.0.0.1', '10.0.0.1', 'curl/8.0', 2, '2025-06-18T16:00:00Z'),
       ('ERROR', 'query', 'SQL syntax error near FROM', '192.168.1.110', 'Bun/1.0', 0, '2025-06-19T17:00:00Z'),
       ('INFO', 'server', 'Health check OK', '192.168.1.1', 'k8s-probe/1.0', 1, '2025-06-20T18:00:00Z');

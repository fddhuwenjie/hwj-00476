const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const dbFile = 'ecommerce.db';

if (fs.existsSync(dbFile)) {
  fs.unlinkSync(dbFile);
}

const db = new sqlite3.Database(dbFile);

const firstNames = ['张', '李', '王', '赵', '刘', '陈', '杨', '黄', '周', '吴', '徐', '孙', '胡', '朱', '高', '林', '何', '郭', '马', '罗'];
const lastNames = ['伟', '芳', '娜', '敏', '静', '丽', '强', '磊', '洋', '艳', '勇', '军', '杰', '娟', '涛', '明', '超', '秀英', '霞', '平'];
const cities = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '西安', '南京', '重庆'];
const productNames = ['智能手机', '笔记本电脑', '蓝牙耳机', '机械键盘', '鼠标', '显示器', '平板电脑', '智能手表', '路由器', '移动电源', '相机', '打印机', '音箱', '耳机', '键盘', '硬盘', '内存条', '显卡', '主板', '机箱'];
const categories = ['电子产品', '数码配件', '计算机设备', '智能家居', '摄影器材', '办公设备'];
const statuses = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];

function randomName() {
  return firstNames[Math.floor(Math.random() * firstNames.length)] + lastNames[Math.floor(Math.random() * lastNames.length)];
}

function randomEmail(name) {
  const domains = ['gmail.com', 'qq.com', '163.com', 'outlook.com', 'hotmail.com'];
  return `${name.toLowerCase().replace(/\s/g, '')}${Math.floor(Math.random() * 1000)}@${domains[Math.floor(Math.random() * domains.length)]}`;
}

function randomPhone() {
  return `1${Math.floor(Math.random() * 9) + 3}${Math.floor(Math.random() * 1000000000).toString().padStart(9, '0')}`;
}

function randomDate(start, end) {
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime())).toISOString().split('T')[0];
}

db.serialize(() => {
  db.run(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    age INTEGER,
    city TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT,
    price REAL NOT NULL,
    stock INTEGER DEFAULT 0,
    description TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    total REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    order_date TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    price REAL NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  )`);

  const userStmt = db.prepare('INSERT INTO users (name, email, phone, age, city, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 1; i <= 100; i++) {
    const name = randomName();
    userStmt.run(
      name,
      randomEmail(name),
      randomPhone(),
      Math.floor(Math.random() * 50) + 18,
      cities[Math.floor(Math.random() * cities.length)],
      randomDate(new Date(2023, 0, 1), new Date(2024, 5, 30))
    );
  }
  userStmt.finalize();

  const productStmt = db.prepare('INSERT INTO products (name, category, price, stock, description) VALUES (?, ?, ?, ?, ?)');
  for (let i = 1; i <= 100; i++) {
    const pname = productNames[Math.floor(Math.random() * productNames.length)];
    productStmt.run(
      `${pname} ${Math.floor(Math.random() * 100)}`,
      categories[Math.floor(Math.random() * categories.length)],
      Math.floor(Math.random() * 5000) + 50,
      Math.floor(Math.random() * 500) + 10,
      `这是一款高品质的${pname}，性能卓越，性价比高。`
    );
  }
  productStmt.finalize();

  const orderStmt = db.prepare('INSERT INTO orders (user_id, total, status, order_date) VALUES (?, ?, ?, ?)');
  const orderItemStmt = db.prepare('INSERT INTO order_items (order_id, product_id, quantity, price) VALUES (?, ?, ?, ?)');
  
  for (let i = 1; i <= 100; i++) {
    const userId = Math.floor(Math.random() * 100) + 1;
    const orderDate = randomDate(new Date(2024, 0, 1), new Date(2024, 11, 31));
    const itemCount = Math.floor(Math.random() * 5) + 1;
    let total = 0;
    
    const orderId = i;
    for (let j = 0; j < itemCount; j++) {
      const productId = Math.floor(Math.random() * 100) + 1;
      const quantity = Math.floor(Math.random() * 5) + 1;
      const price = Math.floor(Math.random() * 5000) + 50;
      total += price * quantity;
      orderItemStmt.run(orderId, productId, quantity, price);
    }
    
    orderStmt.run(userId, total, statuses[Math.floor(Math.random() * statuses.length)], orderDate);
  }
  
  orderStmt.finalize();
  orderItemStmt.finalize();

  console.log('数据库生成完成！');
  console.log('表结构:');
  console.log('  - users (100行): 用户表');
  console.log('  - products (100行): 商品表');
  console.log('  - orders (100行): 订单表 (外键: user_id -> users.id)');
  console.log('  - order_items (约300行): 订单项表 (外键: order_id -> orders.id, product_id -> products.id)');
});

db.close();

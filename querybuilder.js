const sqlite3 = require('sqlite3').verbose();
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const Table = require('cli-table3');
const chalk = require('chalk');

let db = null;
let dbPath = null;
let tableMetadata = {};
let foreignKeys = {};
let history = [];
let savedScripts = {};
let queryLog = [];
let inTransaction = false;
let templates = {};
const historyFile = '.query_history.json';
const scriptsFile = '.saved_scripts.json';
const templatesFile = '.query_templates.json';
const migrationsDir = 'migrations';

function loadPersistentData() {
  try {
    if (fs.existsSync(historyFile)) {
      history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    }
  } catch (e) {
    history = [];
  }
  try {
    if (fs.existsSync(scriptsFile)) {
      savedScripts = JSON.parse(fs.readFileSync(scriptsFile, 'utf8'));
    }
  } catch (e) {
    savedScripts = {};
  }
  try {
    if (fs.existsSync(templatesFile)) {
      templates = JSON.parse(fs.readFileSync(templatesFile, 'utf8'));
    }
  } catch (e) {
    templates = {};
  }
}

function savePersistentData() {
  try {
    fs.writeFileSync(historyFile, JSON.stringify(history.slice(-100), null, 2));
    fs.writeFileSync(scriptsFile, JSON.stringify(savedScripts, null, 2));
    fs.writeFileSync(templatesFile, JSON.stringify(templates, null, 2));
  } catch (e) {}
}

function openDatabase(filePath) {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(filePath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
      if (err) {
        reject(err);
      } else {
        dbPath = filePath;
        loadTableMetadata().then(() => {
          loadPersistentData();
          console.log(chalk.green(`✓ 已连接到数据库: ${filePath}`));
          console.log(chalk.cyan(`  发现 ${Object.keys(tableMetadata).length} 个表`));
          resolve();
        }).catch(reject);
      }
    });
  });
}

function loadTableMetadata() {
  return new Promise((resolve, reject) => {
    db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], (err, tables) => {
      if (err) return reject(err);

      const promises = tables.map(t => {
        return new Promise((res, rej) => {
          const tableName = t.name;
          db.all(`PRAGMA table_info("${tableName}")`, [], (err, columns) => {
            if (err) return rej(err);
            tableMetadata[tableName] = columns;

            db.all(`PRAGMA foreign_key_list("${tableName}")`, [], (err, fks) => {
              if (err) return rej(err);
              foreignKeys[tableName] = fks;
              res();
            });
          });
        });
      });

      Promise.all(promises).then(resolve).catch(reject);
    });
  });
}

function printTable(rows) {
  if (!rows || rows.length === 0) {
    console.log(chalk.yellow('(空结果集)'));
    return;
  }

  const headers = Object.keys(rows[0]);
  const table = new Table({
    head: headers.map(h => chalk.cyan(h)),
    style: { head: [], border: [] }
  });

  rows.forEach(row => {
    table.push(headers.map(h => row[h] !== null ? row[h] : chalk.gray('NULL')));
  });

  console.log(table.toString());
  console.log(chalk.gray(`共 ${rows.length} 行`));
}

function printTableInfo(tableName) {
  const columns = tableMetadata[tableName];
  if (!columns) {
    console.log(chalk.red(`表 '${tableName}' 不存在`));
    return;
  }

  const table = new Table({
    head: [chalk.cyan('列名'), chalk.cyan('类型'), chalk.cyan('约束'), chalk.cyan('主键')],
    style: { head: [], border: [] }
  });

  columns.forEach(col => {
    const constraints = [];
    if (col.notnull) constraints.push('NOT NULL');
    if (col.dflt_value !== null) constraints.push(`DEFAULT ${col.dflt_value}`);
    const fk = (foreignKeys[tableName] || []).find(f => f.from === col.name);
    if (fk) constraints.push(`FK → ${fk.table}.${fk.to}`);

    table.push([
      col.name,
      col.type || chalk.gray('(无)'),
      constraints.join(', ') || chalk.gray('(无)'),
      col.pk ? chalk.green('✓') : ''
    ]);
  });

  console.log(chalk.bold(`\n表: ${tableName}`));
  console.log(table.toString());

  const outFks = foreignKeys[tableName] || [];
  if (outFks.length > 0) {
    console.log(chalk.yellow(`\n外键关系:`));
    outFks.forEach(fk => {
      console.log(`  ${tableName}.${fk.from} → ${fk.table}.${fk.to}`);
    });
  }

  const inFks = [];
  Object.keys(foreignKeys).forEach(t => {
    foreignKeys[t].forEach(fk => {
      if (fk.table === tableName) {
        inFks.push({ from: `${t}.${fk.from}`, to: fk.to });
      }
    });
  });
  if (inFks.length > 0) {
    console.log(chalk.yellow(`\n被引用关系:`));
    inFks.forEach(fk => {
      console.log(`  ${fk.from} → ${tableName}.${fk.to}`);
    });
  }
}

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function runExec(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

class QueryBuilder {
  constructor(tableName) {
    this.table = tableName;
    this._select = ['*'];
    this._where = [];
    this._whereParams = [];
    this._joins = [];
    this._orderBy = [];
    this._groupBy = [];
    this._having = [];
    this._havingParams = [];
    this._limit = null;
    this._offset = null;
    this._aggregates = [];
    this._operation = 'select';
    this._insertData = null;
    this._updateData = null;
    this._subQuery = null;
    this._upsertKey = null;
    this._upsertUpdate = null;
    this._bulkInsertData = null;
  }

  _clone() {
    const qb = new QueryBuilder(this.table);
    Object.assign(qb, JSON.parse(JSON.stringify({
      _select: this._select,
      _where: this._where,
      _whereParams: this._whereParams,
      _joins: this._joins,
      _orderBy: this._orderBy,
      _groupBy: this._groupBy,
      _having: this._having,
      _havingParams: this._havingParams,
      _limit: this._limit,
      _offset: this._offset,
      _aggregates: this._aggregates,
      _operation: this._operation,
      _insertData: this._insertData,
      _updateData: this._updateData,
      _upsertKey: this._upsertKey,
      _upsertUpdate: this._upsertUpdate,
      _bulkInsertData: this._bulkInsertData
    })));
    qb._subQuery = this._subQuery;
    return qb;
  }

  select(...columns) {
    const qb = this._clone();
    qb._select = columns.flat();
    return qb;
  }

  where(condition, ...params) {
    const qb = this._clone();
    if (condition instanceof QueryBuilder) {
      const { sql, params: subParams } = condition._buildSelect();
      qb._where.push(`(${sql})`);
      qb._whereParams.push(...subParams);
    } else {
      qb._where.push(condition);
      qb._whereParams.push(...params);
    }
    return qb;
  }

  orWhere(condition, ...params) {
    const qb = this._clone();
    if (qb._where.length > 0) {
      qb._where[qb._where.length - 1] = `(${qb._where[qb._where.length - 1]}) OR (${condition})`;
    } else {
      qb._where.push(condition);
    }
    qb._whereParams.push(...params);
    return qb;
  }

  whereIn(column, values) {
    const qb = this._clone();
    if (values instanceof QueryBuilder) {
      const { sql, params: subParams } = values._buildSelect();
      qb._where.push(`${column} IN (${sql})`);
      qb._whereParams.push(...subParams);
    } else {
      const placeholders = values.map(() => '?').join(', ');
      qb._where.push(`${column} IN (${placeholders})`);
      qb._whereParams.push(...values);
    }
    return qb;
  }

  whereNull(column) {
    const qb = this._clone();
    qb._where.push(`${column} IS NULL`);
    return qb;
  }

  whereNotNull(column) {
    const qb = this._clone();
    qb._where.push(`${column} IS NOT NULL`);
    return qb;
  }

  whereBetween(column, min, max) {
    const qb = this._clone();
    qb._where.push(`${column} BETWEEN ? AND ?`);
    qb._whereParams.push(min, max);
    return qb;
  }

  _findAutoJoinCondition(table, joinTable) {
    const fks1 = foreignKeys[table] || [];
    const match1 = fks1.find(fk => fk.table === joinTable);
    if (match1) {
      return `${table}.${match1.from} = ${joinTable}.${match1.to}`;
    }

    const fks2 = foreignKeys[joinTable] || [];
    const match2 = fks2.find(fk => fk.table === table);
    if (match2) {
      return `${joinTable}.${match2.from} = ${table}.${match2.to}`;
    }

    return null;
  }

  join(table, condition) {
    return this._join('INNER', table, condition);
  }

  innerJoin(table, condition) {
    return this._join('INNER', table, condition);
  }

  leftJoin(table, condition) {
    return this._join('LEFT', table, condition);
  }

  rightJoin(table, condition) {
    return this._join('RIGHT', table, condition);
  }

  _join(type, table, condition) {
    const qb = this._clone();
    let cond = condition;
    if (!condition) {
      cond = this._findAutoJoinCondition(this.table, table);
      if (!cond) {
        throw new Error(`无法自动推断 ${this.table} 和 ${table} 的关联条件，请手动指定`);
      }
      console.log(chalk.gray(`  自动检测关联: ${cond}`));
    }
    qb._joins.push({ type, table, condition: cond });
    return qb;
  }

  orderBy(column, direction = 'ASC') {
    const qb = this._clone();
    qb._orderBy.push({ column, direction: direction.toUpperCase() });
    return qb;
  }

  groupBy(...columns) {
    const qb = this._clone();
    qb._groupBy.push(...columns.flat());
    return qb;
  }

  having(condition, ...params) {
    const qb = this._clone();
    qb._having.push(condition);
    qb._havingParams.push(...params);
    return qb;
  }

  limit(n) {
    const qb = this._clone();
    qb._limit = n;
    return qb;
  }

  offset(n) {
    const qb = this._clone();
    qb._offset = n;
    return qb;
  }

  count(column = '*') {
    const qb = this._clone();
    qb._aggregates.push({ func: 'COUNT', column, alias: `count_${column.replace(/\*/g, 'all')}` });
    return qb;
  }

  sum(column) {
    const qb = this._clone();
    qb._aggregates.push({ func: 'SUM', column, alias: `sum_${column}` });
    return qb;
  }

  avg(column) {
    const qb = this._clone();
    qb._aggregates.push({ func: 'AVG', column, alias: `avg_${column}` });
    return qb;
  }

  min(column) {
    const qb = this._clone();
    qb._aggregates.push({ func: 'MIN', column, alias: `min_${column}` });
    return qb;
  }

  max(column) {
    const qb = this._clone();
    qb._aggregates.push({ func: 'MAX', column, alias: `max_${column}` });
    return qb;
  }

  insert(data) {
    const qb = this._clone();
    qb._operation = 'insert';
    qb._insertData = data;
    return qb;
  }

  update(data) {
    const qb = this._clone();
    qb._operation = 'update';
    qb._updateData = data;
    return qb;
  }

  delete() {
    const qb = this._clone();
    qb._operation = 'delete';
    return qb;
  }

  upsert(keyObj, updateObj) {
    const qb = this._clone();
    qb._operation = 'upsert';
    qb._upsertKey = keyObj;
    qb._upsertUpdate = updateObj;
    return qb;
  }

  bulkInsert(dataArray) {
    const qb = this._clone();
    qb._operation = 'bulkInsert';
    qb._bulkInsertData = dataArray;
    return qb;
  }

  _buildSelect() {
    let columns = this._select;

    if (this._aggregates.length > 0) {
      const aggCols = this._aggregates.map(a => `${a.func}(${a.column}) AS ${a.alias}`);
      columns = [...this._groupBy, ...aggCols];
    }

    let sql = `SELECT ${columns.join(', ')} FROM "${this.table}"`;
    let params = [];

    this._joins.forEach(join => {
      sql += ` ${join.type} JOIN "${join.table}" ON ${join.condition}`;
    });

    if (this._where.length > 0) {
      sql += ` WHERE ${this._where.join(' AND ')}`;
      params.push(...this._whereParams);
    }

    if (this._groupBy.length > 0) {
      sql += ` GROUP BY ${this._groupBy.join(', ')}`;
    }

    if (this._having.length > 0) {
      sql += ` HAVING ${this._having.join(' AND ')}`;
      params.push(...this._havingParams);
    }

    if (this._orderBy.length > 0) {
      const orderClauses = this._orderBy.map(o => `${o.column} ${o.direction}`);
      sql += ` ORDER BY ${orderClauses.join(', ')}`;
    }

    if (this._limit !== null) {
      sql += ` LIMIT ${this._limit}`;
    }

    if (this._offset !== null) {
      sql += ` OFFSET ${this._offset}`;
    }

    return { sql, params };
  }

  _buildInsert() {
    const data = this._insertData;
    const columns = Object.keys(data);
    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT INTO "${this.table}" (${columns.join(', ')}) VALUES (${placeholders})`;
    const params = columns.map(c => data[c]);
    return { sql, params };
  }

  _buildUpdate() {
    const data = this._updateData;
    const setClauses = Object.keys(data).map(k => `${k} = ?`);
    let sql = `UPDATE "${this.table}" SET ${setClauses.join(', ')}`;
    let params = Object.values(data);

    if (this._where.length > 0) {
      sql += ` WHERE ${this._where.join(' AND ')}`;
      params.push(...this._whereParams);
    }

    return { sql, params };
  }

  _buildDelete() {
    let sql = `DELETE FROM "${this.table}"`;
    let params = [];

    if (this._where.length > 0) {
      sql += ` WHERE ${this._where.join(' AND ')}`;
      params.push(...this._whereParams);
    }

    return { sql, params };
  }

  _buildUpsert() {
    const keyObj = this._upsertKey;
    const updateObj = this._upsertUpdate;
    const allData = Object.assign({}, keyObj, updateObj);
    const allColumns = Object.keys(allData);
    const keyColumns = Object.keys(keyObj);
    const updateColumns = Object.keys(updateObj);
    const placeholders = allColumns.map(() => '?').join(', ');
    const conflictCols = keyColumns.join(', ');
    const setClauses = updateColumns.map(c => `${c} = ?`).join(', ');
    const sql = `INSERT INTO "${this.table}" (${allColumns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${conflictCols}) DO UPDATE SET ${setClauses}`;
    const params = [...allColumns.map(c => allData[c]), ...updateColumns.map(c => updateObj[c])];
    return { sql, params };
  }

  _buildBulkInsert() {
    const dataArray = this._bulkInsertData;
    if (!dataArray || dataArray.length === 0) {
      throw new Error('bulkInsert 需要非空数组');
    }
    const columns = Object.keys(dataArray[0]);
    const rowPlaceholders = `(${columns.map(() => '?').join(', ')})`;
    const allPlaceholders = dataArray.map(() => rowPlaceholders).join(', ');
    const sql = `INSERT INTO "${this.table}" (${columns.join(', ')}) VALUES ${allPlaceholders}`;
    const params = [];
    dataArray.forEach(row => {
      columns.forEach(c => params.push(row[c] !== undefined ? row[c] : null));
    });
    return { sql, params };
  }

  toSQL() {
    switch (this._operation) {
      case 'insert': return this._buildInsert();
      case 'update': return this._buildUpdate();
      case 'delete': return this._buildDelete();
      case 'upsert': return this._buildUpsert();
      case 'bulkInsert': return this._buildBulkInsert();
      default: return this._buildSelect();
    }
  }

  then(onFulfilled, onRejected) {
    return this.exec().then(onFulfilled, onRejected);
  }

  async exec() {
    const { sql, params } = this.toSQL();
    console.log(chalk.blue(`\n生成的 SQL: ${sql}`));
    if (params.length > 0) {
      console.log(chalk.gray(`参数: [${params.join(', ')}]`));
    }

    const start = Date.now();

    if (this._operation === 'select') {
      const rows = await runQuery(sql, params);
      const duration = Date.now() - start;
      queryLog.push({ sql, params, duration, timestamp: new Date().toISOString() });
      console.log(chalk.green(`\n✓ 查询成功 (${duration}ms)`));
      printTable(rows);
      return rows;
    } else {
      const result = await runExec(sql, params);
      const duration = Date.now() - start;
      queryLog.push({ sql, params, duration, timestamp: new Date().toISOString() });
      console.log(chalk.green(`\n✓ 操作成功 (${duration}ms)`));
      if (this._operation === 'insert') {
        console.log(`  影响行数: ${result.changes}, 新记录ID: ${result.lastID}`);
      } else if (this._operation === 'upsert') {
        console.log(`  影响行数: ${result.changes}`);
      } else if (this._operation === 'bulkInsert') {
        console.log(`  插入行数: ${result.changes}`);
      } else {
        console.log(`  影响行数: ${result.changes}`);
      }
      return result;
    }
  }

  async export(format, filename) {
    const rows = await this.exec();
    let content = '';

    switch (format.toLowerCase()) {
      case 'csv':
        if (rows.length > 0) {
          const headers = Object.keys(rows[0]);
          content = headers.join(',') + '\n';
          rows.forEach(row => {
            content += headers.map(h => {
              const val = row[h];
              if (typeof val === 'string' && val.includes(',')) {
                return `"${val.replace(/"/g, '""')}"`;
              }
              return val !== null ? val : '';
            }).join(',') + '\n';
          });
        }
        break;
      case 'json':
        content = JSON.stringify(rows, null, 2);
        break;
      case 'md':
      case 'markdown':
        if (rows.length > 0) {
          const headers = Object.keys(rows[0]);
          content = '| ' + headers.join(' | ') + ' |\n';
          content += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
          rows.forEach(row => {
            content += '| ' + headers.map(h => row[h] !== null ? row[h] : '').join(' | ') + ' |\n';
          });
        }
        break;
      default:
        throw new Error(`不支持的导出格式: ${format}`);
    }

    const exportFile = filename || `export_${Date.now()}.${format.toLowerCase()}`;
    fs.writeFileSync(exportFile, content, 'utf8');
    console.log(chalk.green(`\n✓ 已导出到 ${exportFile}`));
    return rows;
  }

  save(name) {
    const { sql, params } = this.toSQL();
    savedScripts[name] = {
      sql,
      params,
      operation: this._operation,
      createdAt: new Date().toISOString()
    };
    savePersistentData();
    console.log(chalk.green(`✓ 脚本已保存为 '${name}'`));
    return this;
  }
}

function createDbProxy() {
  return new Proxy({}, {
    get: (target, prop) => {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then') return undefined;

      if (prop === 'toSQL') return () => '';
      if (prop === 'exec') return async () => [];

      return new QueryBuilder(prop);
    }
  });
}

const dbProxy = createDbProxy();

function exportToCsv(rows, filename) {
  let content = '';
  if (rows.length > 0) {
    const headers = Object.keys(rows[0]);
    content = headers.join(',') + '\n';
    rows.forEach(row => {
      content += headers.map(h => {
        const val = row[h];
        if (typeof val === 'string' && val.includes(',')) {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val !== null ? val : '';
      }).join(',') + '\n';
    });
  }
  const exportFile = filename || `export_${Date.now()}.csv`;
  fs.writeFileSync(exportFile, content, 'utf8');
  console.log(chalk.green(`✓ 已导出到 ${exportFile}`));
}

function exportToJson(rows, filename) {
  const exportFile = filename || `export_${Date.now()}.json`;
  fs.writeFileSync(exportFile, JSON.stringify(rows, null, 2), 'utf8');
  console.log(chalk.green(`✓ 已导出到 ${exportFile}`));
}

function exportToMarkdown(rows, filename) {
  let content = '';
  if (rows.length > 0) {
    const headers = Object.keys(rows[0]);
    content = '| ' + headers.join(' | ') + ' |\n';
    content += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
    rows.forEach(row => {
      content += '| ' + headers.map(h => row[h] !== null ? row[h] : '').join(' | ') + ' |\n';
    });
  }
  const exportFile = filename || `export_${Date.now()}.md`;
  fs.writeFileSync(exportFile, content, 'utf8');
  console.log(chalk.green(`✓ 已导出到 ${exportFile}`));
}

function createMigrationHelper() {
  return {
    db: dbProxy,
    createTable: async (name, columns) => {
      const cols = Object.entries(columns).map(([col, def]) => `${col} ${def}`).join(', ');
      await runExec(`CREATE TABLE IF NOT EXISTS "${name}" (${cols})`);
      await loadTableMetadata();
    },
    dropTable: async (name) => {
      await runExec(`DROP TABLE IF EXISTS "${name}"`);
      await loadTableMetadata();
    },
    addColumn: async (table, column, definition) => {
      await runExec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
      await loadTableMetadata();
    },
    dropColumn: async (table, column) => {
      await runExec(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
      await loadTableMetadata();
    },
    addIndex: async (table, columns, name) => {
      const indexName = name || `idx_${table}_${Array.isArray(columns) ? columns.join('_') : columns}`;
      const colList = Array.isArray(columns) ? columns.join(', ') : columns;
      await runExec(`CREATE INDEX IF NOT EXISTS "${indexName}" ON "${table}" (${colList})`);
    },
    dropIndex: async (name) => {
      await runExec(`DROP INDEX IF EXISTS "${name}"`);
    },
    renameTable: async (oldName, newName) => {
      await runExec(`ALTER TABLE "${oldName}" RENAME TO "${newName}"`);
      await loadTableMetadata();
    },
    raw: async (sql, params) => {
      if (sql.trim().toUpperCase().startsWith('SELECT')) {
        return await runQuery(sql, params || []);
      }
      return await runExec(sql, params || []);
    }
  };
}

async function ensureMigrationsTable() {
  await runExec(`CREATE TABLE IF NOT EXISTS migrations_log (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)`);
}

async function getAppliedMigrations() {
  await ensureMigrationsTable();
  return await runQuery('SELECT name, applied_at FROM migrations_log ORDER BY id');
}

function getMigrationFiles() {
  if (!fs.existsSync(migrationsDir)) {
    fs.mkdirSync(migrationsDir, { recursive: true });
    return [];
  }
  return fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.js'))
    .sort();
}

async function migrateCreate(name) {
  if (!fs.existsSync(migrationsDir)) {
    fs.mkdirSync(migrationsDir, { recursive: true });
  }
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const filename = `${timestamp}_${name}.js`;
  const filepath = path.join(migrationsDir, filename);
  const content = `exports.up = async function(helper) {\n  \n};\n\nexports.down = async function(helper) {\n  \n};\n`;
  fs.writeFileSync(filepath, content, 'utf8');
  console.log(chalk.green(`✓ 已创建迁移文件: ${filepath}`));
}

async function migrateUp() {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const appliedNames = new Set(applied.map(r => r.name));
  const files = getMigrationFiles();
  const pending = files.filter(f => !appliedNames.has(f));

  if (pending.length === 0) {
    console.log(chalk.yellow('没有待执行的迁移'));
    return;
  }

  const helper = createMigrationHelper();

  for (const file of pending) {
    const filepath = path.resolve(migrationsDir, file);
    delete require.cache[require.resolve(filepath)];
    const migration = require(filepath);

    try {
      console.log(chalk.cyan(`执行迁移: ${file}`));
      await migration.up(helper);
      await runExec('INSERT INTO migrations_log (name, applied_at) VALUES (?, ?)', [file, new Date().toISOString()]);
      console.log(chalk.green(`✓ 已应用: ${file}`));
    } catch (e) {
      console.log(chalk.red(`✗ 迁移失败: ${file} - ${e.message}`));
      break;
    }
  }

  await loadTableMetadata();
}

async function migrateDown() {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();

  if (applied.length === 0) {
    console.log(chalk.yellow('没有可回滚的迁移'));
    return;
  }

  const lastMigration = applied[applied.length - 1];
  const filepath = path.resolve(migrationsDir, lastMigration.name);

  if (!fs.existsSync(filepath)) {
    console.log(chalk.red(`迁移文件不存在: ${filepath}`));
    return;
  }

  delete require.cache[require.resolve(filepath)];
  const migration = require(filepath);
  const helper = createMigrationHelper();

  try {
    console.log(chalk.cyan(`回滚迁移: ${lastMigration.name}`));
    await migration.down(helper);
    await runExec('DELETE FROM migrations_log WHERE name = ?', [lastMigration.name]);
    console.log(chalk.green(`✓ 已回滚: ${lastMigration.name}`));
  } catch (e) {
    console.log(chalk.red(`✗ 回滚失败: ${e.message}`));
  }

  await loadTableMetadata();
}

async function migrateStatus() {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();
  const appliedNames = new Set(applied.map(r => r.name));
  const appliedMap = {};
  applied.forEach(r => { appliedMap[r.name] = r.applied_at; });
  const files = getMigrationFiles();

  if (files.length === 0) {
    console.log(chalk.yellow('没有迁移文件'));
    return;
  }

  const table = new Table({
    head: [chalk.cyan('迁移文件'), chalk.cyan('状态'), chalk.cyan('应用时间')],
    style: { head: [], border: [] }
  });

  files.forEach(f => {
    if (appliedNames.has(f)) {
      table.push([f, chalk.green('已应用'), appliedMap[f]]);
    } else {
      table.push([f, chalk.yellow('待执行'), '']);
    }
  });

  console.log(table.toString());
}

async function explainQuery(queryStr) {
  try {
    const qb = eval(`(function(db) { return ${queryStr}; })(dbProxy)`);
    const { sql, params } = qb.toSQL();
    console.log(chalk.blue(`查询 SQL: ${sql}`));
    if (params.length > 0) {
      console.log(chalk.gray(`参数: [${params.join(', ')}]`));
    }

    const explainRows = await runQuery(`EXPLAIN QUERY PLAN ${sql}`, params);

    console.log(chalk.bold('\n执行计划:'));
    explainRows.forEach(row => {
      const detail = row.detail || '';
      let icon = chalk.cyan('→');
      if (detail.includes('SCAN TABLE')) icon = chalk.yellow('⚠ 全表扫描');
      if (detail.includes('USING INDEX')) icon = chalk.green('✓ 使用索引');
      if (detail.includes('USING COVERING INDEX')) icon = chalk.green('✓ 覆盖索引');
      console.log(`  ${icon} ${detail}`);
    });
  } catch (e) {
    console.log(chalk.red(`错误: ${e.message}`));
  }
}

async function suggestIndexes() {
  const suggestions = [];

  for (const tableName of Object.keys(foreignKeys)) {
    const fks = foreignKeys[tableName];
    if (!fks || fks.length === 0) continue;

    let indexes;
    try {
      indexes = await runQuery(`PRAGMA index_list("${tableName}")`);
    } catch (e) {
      continue;
    }

    const indexedColumns = new Set();
    for (const idx of indexes) {
      try {
        const idxInfo = await runQuery(`PRAGMA index_info("${idx.name}")`);
        idxInfo.forEach(i => indexedColumns.add(i.name));
      } catch (e) {}
    }

    fks.forEach(fk => {
      if (!indexedColumns.has(fk.from)) {
        suggestions.push({
          table: tableName,
          column: fk.from,
          reason: `外键列缺少索引 (${tableName}.${fk.from} → ${fk.table}.${fk.to})`,
          sql: `CREATE INDEX idx_${tableName}_${fk.from} ON "${tableName}" (${fk.from});`
        });
      }
    });
  }

  for (const tableName of Object.keys(tableMetadata)) {
    const columns = tableMetadata[tableName];
    try {
      const indexes = await runQuery(`PRAGMA index_list("${tableName}")`);
      const indexedColumns = new Set();
      for (const idx of indexes) {
        const idxInfo = await runQuery(`PRAGMA index_info("${idx.name}")`);
        idxInfo.forEach(i => indexedColumns.add(i.name));
      }
      columns.forEach(col => {
        if (!col.pk && col.notnull && !indexedColumns.has(col.name)) {
          const alreadySuggested = suggestions.some(s => s.table === tableName && s.column === col.name);
          if (!alreadySuggested) {
            suggestions.push({
              table: tableName,
              column: col.name,
              reason: `高频查询列建议加索引 (${tableName}.${col.name})`,
              sql: `CREATE INDEX idx_${tableName}_${col.name} ON "${tableName}" (${col.name});`
            });
          }
        }
      });
    } catch (e) {}
  }

  if (suggestions.length === 0) {
    console.log(chalk.green('✓ 未发现明显的索引缺失'));
    return;
  }

  console.log(chalk.bold('\n索引建议:'));
  suggestions.forEach((s, i) => {
    console.log(chalk.yellow(`\n${i + 1}. ${s.reason}`));
    console.log(chalk.cyan(`   ${s.sql}`));
  });
}

function showSlowQueries(threshold) {
  const th = parseInt(threshold) || 100;
  const slow = queryLog.filter(q => q.duration >= th);

  if (slow.length === 0) {
    console.log(chalk.green(`✓ 没有超过 ${th}ms 的慢查询`));
    return;
  }

  console.log(chalk.bold(`\n慢查询 (>= ${th}ms):`));
  const table = new Table({
    head: [chalk.cyan('SQL'), chalk.cyan('耗时'), chalk.cyan('时间')],
    style: { head: [], border: [] }
  });

  slow.forEach(q => {
    const shortSql = q.sql.length > 60 ? q.sql.slice(0, 60) + '...' : q.sql;
    table.push([shortSql, `${q.duration}ms`, q.timestamp]);
  });

  console.log(table.toString());
}

async function generateSchema(outputFile) {
  let dot = 'digraph ER {\n';
  dot += '  node [shape=record];\n';
  dot += '  rankdir=LR;\n\n';

  for (const tableName of Object.keys(tableMetadata)) {
    const columns = tableMetadata[tableName];
    const fks = foreignKeys[tableName] || [];
    const fkMap = {};
    fks.forEach(fk => { fkMap[fk.from] = fk; });

    let label = `{${tableName}|`;
    columns.forEach(col => {
      let colDef = col.name + ' ' + (col.type || '');
      if (col.pk) colDef += ' PK';
      if (fkMap[col.name]) colDef += ' FK';
      if (col.notnull) colDef += ' NOT NULL';
      label += colDef + '\\l';
    });
    label += '}';

    dot += `  "${tableName}" [label="${label}"];\n`;
  }

  dot += '\n';

  for (const tableName of Object.keys(foreignKeys)) {
    const fks = foreignKeys[tableName];
    fks.forEach(fk => {
      dot += `  "${tableName}" -> "${fk.table}" [label="${fk.from} → ${fk.to}"];\n`;
    });
  }

  dot += '}\n';

  if (outputFile) {
    fs.writeFileSync(outputFile, dot, 'utf8');
    console.log(chalk.green(`✓ ER图已保存到 ${outputFile}`));
  } else {
    console.log(dot);
  }
}

async function generateDoc(outputFile) {
  let md = '# Database Documentation\n\n';
  md += `Generated: ${new Date().toISOString()}\n\n`;
  md += `Tables: ${Object.keys(tableMetadata).length}\n\n`;

  for (const tableName of Object.keys(tableMetadata)) {
    const columns = tableMetadata[tableName];
    const fks = foreignKeys[tableName] || [];

    md += `## ${tableName}\n\n`;

    md += '| Column | Type | Nullable | Default | Primary Key |\n';
    md += '|--------|------|----------|---------|-------------|\n';
    columns.forEach(col => {
      const fk = fks.find(f => f.from === col.name);
      let type = col.type || '-';
      if (fk) type += ` (FK → ${fk.table}.${fk.to})`;
      md += `| ${col.name} | ${type} | ${col.notnull ? 'No' : 'Yes'} | ${col.dflt_value !== null ? col.dflt_value : '-'} | ${col.pk ? 'Yes' : 'No'} |\n`;
    });
    md += '\n';

    if (fks.length > 0) {
      md += '### Foreign Keys\n\n';
      fks.forEach(fk => {
        md += `- ${tableName}.${fk.from} → ${fk.table}.${fk.to}\n`;
      });
      md += '\n';
    }

    try {
      const indexes = await runQuery(`PRAGMA index_list("${tableName}")`);
      if (indexes.length > 0) {
        md += '### Indexes\n\n';
        md += '| Index Name | Unique | Columns |\n';
        md += '|------------|--------|--------|\n';
        for (const idx of indexes) {
          const idxInfo = await runQuery(`PRAGMA index_info("${idx.name}")`);
          const cols = idxInfo.map(i => i.name).join(', ');
          md += `| ${idx.name} | ${idx.unique ? 'Yes' : 'No'} | ${cols} |\n`;
        }
        md += '\n';
      }
    } catch (e) {}

    try {
      const sampleRows = await runQuery(`SELECT * FROM "${tableName}" LIMIT 3`);
      if (sampleRows.length > 0) {
        md += '### Sample Data\n\n';
        const headers = Object.keys(sampleRows[0]);
        md += '| ' + headers.join(' | ') + ' |\n';
        md += '| ' + headers.map(() => '---').join(' | ') + ' |\n';
        sampleRows.forEach(row => {
          md += '| ' + headers.map(h => row[h] !== null ? row[h] : 'NULL').join(' | ') + ' |\n';
        });
        md += '\n';
      }
    } catch (e) {}
  }

  if (outputFile) {
    fs.writeFileSync(outputFile, md, 'utf8');
    console.log(chalk.green(`✓ 文档已保存到 ${outputFile}`));
  } else {
    console.log(md);
  }
}

function resolveTemplate(name, visited) {
  if (!visited) visited = new Set();
  if (visited.has(name)) throw new Error(`循环引用模板: ${name}`);
  visited.add(name);

  const tmpl = templates[name];
  if (!tmpl) throw new Error(`模板 '${name}' 不存在`);

  let query = tmpl.query;
  query = query.replace(/\{\{(\w+)\}\}/g, function(match, refName) {
    return resolveTemplate(refName, new Set(visited));
  });

  return query;
}

function extractParams(query) {
  const params = [];
  const regex = /:(\w+)/g;
  let match;
  while ((match = regex.exec(query)) !== null) {
    if (!params.includes(match[1])) {
      params.push(match[1]);
    }
  }
  return params;
}

function templateCreate(name, query) {
  templates[name] = {
    query: query,
    createdAt: new Date().toISOString()
  };
  savePersistentData();
  console.log(chalk.green(`✓ 模板 '${name}' 已创建`));
  const params = extractParams(query);
  if (params.length > 0) {
    console.log(chalk.gray(`  参数: ${params.map(p => ':' + p).join(', ')}`));
  }
}

async function templateRun(name, paramStr) {
  let query = resolveTemplate(name);

  const params = {};
  if (paramStr) {
    paramStr.split(/\s+/).forEach(p => {
      const eqIdx = p.indexOf('=');
      if (eqIdx > 0 && p.startsWith('--')) {
        const key = p.slice(2, eqIdx);
        const value = p.slice(eqIdx + 1);
        params[key] = value;
      }
    });
  }

  Object.entries(params).forEach(([key, value]) => {
    query = query.replace(new RegExp(`:${key}\\b`, 'g'), value);
  });

  console.log(chalk.cyan(`解析后的查询: ${query}`));
  await executeCommand(query);
}

function templateList() {
  const names = Object.keys(templates);
  if (names.length === 0) {
    console.log(chalk.yellow('暂无保存的模板'));
    return;
  }

  const table = new Table({
    head: [chalk.cyan('名称'), chalk.cyan('查询'), chalk.cyan('参数')],
    style: { head: [], border: [] }
  });

  names.forEach(name => {
    const params = extractParams(templates[name].query);
    const queryStr = templates[name].query;
    table.push([
      name,
      queryStr.length > 50 ? queryStr.slice(0, 50) + '...' : queryStr,
      params.length > 0 ? params.map(p => ':' + p).join(', ') : '(无)'
    ]);
  });

  console.log(table.toString());
}

async function executeCommand(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  if (trimmed === 'exit' || trimmed === 'quit' || trimmed === '.exit') {
    console.log(chalk.yellow('再见!'));
    savePersistentData();
    process.exit(0);
  }

  if (trimmed === 'help' || trimmed === '.help') {
    printHelp();
    return;
  }

  if (trimmed === 'tables') {
    const tables = Object.keys(tableMetadata);
    console.log(chalk.bold('\n数据库中的表:'));
    tables.forEach(t => {
      const count = tableMetadata[t].length;
      console.log(`  ${chalk.cyan(t)} (${count} 列)`);
    });
    console.log();
    return;
  }

  if (trimmed.startsWith('describe ')) {
    const tableName = trimmed.slice(9).trim();
    printTableInfo(tableName);
    return;
  }

  if (trimmed.startsWith('sample ')) {
    const tableName = trimmed.slice(7).trim();
    if (!tableMetadata[tableName]) {
      console.log(chalk.red(`表 '${tableName}' 不存在`));
      return;
    }
    const sql = `SELECT * FROM "${tableName}" LIMIT 10`;
    console.log(chalk.blue(`\n生成的 SQL: ${sql}`));
    const rows = await runQuery(sql);
    console.log(chalk.green('\n✓ 查询成功'));
    printTable(rows);
    return;
  }

  if (trimmed.startsWith('count ')) {
    const tableName = trimmed.slice(6).trim();
    if (!tableMetadata[tableName]) {
      console.log(chalk.red(`表 '${tableName}' 不存在`));
      return;
    }
    const sql = `SELECT COUNT(*) as count FROM "${tableName}"`;
    console.log(chalk.blue(`\n生成的 SQL: ${sql}`));
    const rows = await runQuery(sql);
    console.log(chalk.green(`\n✓ 表 '${tableName}' 共有 ${rows[0].count} 行数据`));
    return;
  }

  if (trimmed === 'history') {
    console.log(chalk.bold('\n查询历史:'));
    history.forEach((h, i) => {
      console.log(`  ${i + 1}. [${h.time}] ${chalk.gray(h.query)}`);
    });
    console.log();
    return;
  }

  if (trimmed.startsWith('save ')) {
    const parts = trimmed.slice(5).trim().split(/\s+/);
    const name = parts[0];
    const query = parts.slice(1).join(' ');
    if (!name || !query) {
      console.log(chalk.red('用法: save <名称> <查询语句>'));
      return;
    }
    savedScripts[name] = {
      query,
      createdAt: new Date().toISOString()
    };
    savePersistentData();
    console.log(chalk.green(`✓ 脚本 '${name}' 已保存`));
    return;
  }

  if (trimmed.startsWith('run ')) {
    const name = trimmed.slice(4).trim();
    const script = savedScripts[name];
    if (!script) {
      console.log(chalk.red(`脚本 '${name}' 不存在`));
      return;
    }
    console.log(chalk.cyan(`执行脚本 '${name}': ${script.query}`));
    await executeCommand(script.query);
    return;
  }

  if (trimmed === 'scripts' || trimmed === 'ls scripts') {
    console.log(chalk.bold('\n已保存的脚本:'));
    Object.keys(savedScripts).forEach(name => {
      const s = savedScripts[name];
      console.log(`  ${chalk.cyan(name)}: ${s.query}`);
    });
    if (Object.keys(savedScripts).length === 0) {
      console.log(chalk.gray('  (暂无保存的脚本)'));
    }
    console.log();
    return;
  }

  if (trimmed.startsWith('.read ')) {
    const filePath = trimmed.slice(6).trim();
    if (!fs.existsSync(filePath)) {
      console.log(chalk.red(`文件不存在: ${filePath}`));
      return;
    }
    const content = fs.readFileSync(filePath, 'utf8');

    if (filePath.endsWith('.js')) {
      console.log(chalk.cyan(`执行 JavaScript 文件: ${filePath}`));
      eval(content);
    } else {
      console.log(chalk.cyan(`执行 SQL 文件: ${filePath}`));
      const statements = content.split(';').filter(s => s.trim());
      for (const stmt of statements) {
        console.log(chalk.blue(`\nSQL: ${stmt.trim()}`));
        try {
          const rows = await runQuery(stmt.trim());
          if (rows.length > 0) {
            printTable(rows);
          } else {
            console.log(chalk.green('  ✓ 执行成功'));
          }
        } catch (e) {
          console.log(chalk.red(`  ✗ 错误: ${e.message}`));
        }
      }
    }
    return;
  }

  if (trimmed.startsWith('export ')) {
    const parts = trimmed.slice(7).trim().split(/\s+/);
    if (parts.length < 2) {
      console.log(chalk.red('用法: export <格式> <文件名> <查询语句>'));
      console.log(chalk.gray('  格式支持: csv, json, md'));
      return;
    }
    const format = parts[0].toLowerCase();
    const filename = parts[1];
    const query = parts.slice(2).join(' ');

    const result = await evaluateQuery(query);
    if (result && result.rows) {
      if (format === 'csv') exportToCsv(result.rows, filename);
      else if (format === 'json') exportToJson(result.rows, filename);
      else if (format === 'md' || format === 'markdown') exportToMarkdown(result.rows, filename);
      else console.log(chalk.red(`不支持的格式: ${format}`));
    }
    return;
  }

  if (trimmed.startsWith('migrate ')) {
    const sub = trimmed.slice(8).trim();
    if (sub.startsWith('create ')) {
      const name = sub.slice(7).trim();
      if (!name) {
        console.log(chalk.red('用法: migrate create <名称>'));
        return;
      }
      await migrateCreate(name);
    } else if (sub === 'up') {
      await migrateUp();
    } else if (sub === 'down') {
      await migrateDown();
    } else if (sub === 'status') {
      await migrateStatus();
    } else {
      console.log(chalk.red('用法: migrate create <名称> | migrate up | migrate down | migrate status'));
    }
    return;
  }

  if (trimmed.startsWith('explain ')) {
    const queryStr = trimmed.slice(8).trim();
    await explainQuery(queryStr);
    return;
  }

  if (trimmed === 'suggest') {
    await suggestIndexes();
    return;
  }

  if (trimmed.startsWith('slow')) {
    const parts = trimmed.slice(4).trim();
    showSlowQueries(parts || '100');
    return;
  }

  if (trimmed === 'begin') {
    if (inTransaction) {
      console.log(chalk.yellow('已在事务中'));
      return;
    }
    try {
      await runExec('BEGIN TRANSACTION');
      inTransaction = true;
      console.log(chalk.green('✓ 事务已开始'));
    } catch (e) {
      console.log(chalk.red(`错误: ${e.message}`));
    }
    return;
  }

  if (trimmed === 'commit') {
    if (!inTransaction) {
      console.log(chalk.yellow('没有活动的事务'));
      return;
    }
    try {
      await runExec('COMMIT');
      inTransaction = false;
      console.log(chalk.green('✓ 事务已提交'));
    } catch (e) {
      console.log(chalk.red(`错误: ${e.message}`));
    }
    return;
  }

  if (trimmed === 'rollback') {
    if (!inTransaction) {
      console.log(chalk.yellow('没有活动的事务'));
      return;
    }
    try {
      await runExec('ROLLBACK');
      inTransaction = false;
      console.log(chalk.green('✓ 事务已回滚'));
    } catch (e) {
      console.log(chalk.red(`错误: ${e.message}`));
    }
    return;
  }

  if (trimmed.startsWith('batch ')) {
    const batchStr = trimmed.slice(6).trim();
    let queries;
    try {
      queries = eval(batchStr);
    } catch (e) {
      console.log(chalk.red(`解析批量查询失败: ${e.message}`));
      return;
    }
    if (!Array.isArray(queries) || queries.length === 0) {
      console.log(chalk.red('batch 需要查询字符串数组'));
      return;
    }
    try {
      await runExec('BEGIN TRANSACTION');
      inTransaction = true;
      for (let i = 0; i < queries.length; i++) {
        try {
          console.log(chalk.cyan(`\n[${i + 1}/${queries.length}] ${queries[i]}`));
          await evaluateQuery(queries[i]);
        } catch (e) {
          await runExec('ROLLBACK');
          inTransaction = false;
          console.log(chalk.red(`\n✗ 批量操作在第 ${i + 1} 条失败: ${e.message}`));
          console.log(chalk.yellow('所有操作已回滚'));
          return;
        }
      }
      await runExec('COMMIT');
      inTransaction = false;
      console.log(chalk.green(`\n✓ 批量操作成功 (${queries.length} 条)`));
    } catch (e) {
      console.log(chalk.red(`批量操作错误: ${e.message}`));
      try {
        if (inTransaction) {
          await runExec('ROLLBACK');
          inTransaction = false;
        }
      } catch (e2) {}
    }
    return;
  }

  if (trimmed.startsWith('schema')) {
    const rest = trimmed.slice(6).trim();
    let outputFile = null;
    const oMatch = rest.match(/-o\s+(\S+)/);
    if (oMatch) {
      outputFile = oMatch[1];
    }
    await generateSchema(outputFile);
    return;
  }

  if (trimmed.startsWith('doc')) {
    const rest = trimmed.slice(3).trim();
    let outputFile = null;
    const oMatch = rest.match(/-o\s+(\S+)/);
    if (oMatch) {
      outputFile = oMatch[1];
    }
    await generateDoc(outputFile);
    return;
  }

  if (trimmed.startsWith('template ')) {
    const sub = trimmed.slice(9).trim();
    if (sub.startsWith('create ')) {
      const parts = sub.slice(7).trim();
      const spaceIdx = parts.indexOf(' ');
      if (spaceIdx < 0) {
        console.log(chalk.red('用法: template create <名称> <查询>'));
        return;
      }
      const name = parts.slice(0, spaceIdx);
      const query = parts.slice(spaceIdx + 1);
      templateCreate(name, query);
    } else if (sub.startsWith('run ')) {
      const rest = sub.slice(4).trim();
      const spaceIdx = rest.indexOf(' ');
      let name, paramStr;
      if (spaceIdx < 0) {
        name = rest;
        paramStr = '';
      } else {
        name = rest.slice(0, spaceIdx);
        paramStr = rest.slice(spaceIdx + 1);
      }
      await templateRun(name, paramStr);
    } else if (sub === 'list') {
      templateList();
    } else {
      console.log(chalk.red('用法: template create <名称> <查询> | template run <名称> [--param=value...] | template list'));
    }
    return;
  }

  if (trimmed.startsWith('db.') || trimmed.startsWith('db[')) {
    history.push({ time: new Date().toLocaleTimeString(), query: trimmed });
    savePersistentData();
    await evaluateQuery(trimmed);
    return;
  }

  try {
    history.push({ time: new Date().toLocaleTimeString(), query: trimmed });
    savePersistentData();
    console.log(chalk.blue(`\nSQL: ${trimmed}`));
    const rows = await runQuery(trimmed);
    printTable(rows);
  } catch (e) {
    console.log(chalk.red(`错误: ${e.message}`));
  }
}

async function evaluateQuery(queryStr) {
  try {
    const trimmed = queryStr.trim().replace(/;+$/, '');
    const result = await eval(`(async function(db, console) { return ${trimmed}; })(dbProxy, console)`);
    return result;
  } catch (e) {
    console.log(chalk.red(`错误: ${e.message}`));
    return null;
  }
}

function printHelp() {
  console.log(chalk.bold('\n可用命令:'));
  console.log(chalk.cyan('\n数据库探索:'));
  console.log('  tables              - 列出所有表');
  console.log('  describe <table>    - 显示表结构');
  console.log('  sample <table>      - 显示前10行数据');
  console.log('  count <table>       - 显示行数');

  console.log(chalk.cyan('\n链式查询示例:'));
  console.log('  db.users.where("age > ?", 25).select("name", "email").orderBy("name").limit(10)');
  console.log('  db.orders.join("users").select("users.name", "orders.total").limit(5)');
  console.log('  db.orders.groupBy("status").count().sum("total").avg("total")');

  console.log(chalk.cyan('\n数据操作:'));
  console.log('  db.users.insert({name: "张三", age: 30})');
  console.log('  db.users.where("id = ?", 1).update({age: 31})');
  console.log('  db.users.where("id = ?", 1).delete()');
  console.log('  db.users.upsert({email: "x@x.com"}, {name: "新名字"})');
  console.log('  db.users.bulkInsert([{name: "A"}, {name: "B"}])');

  console.log(chalk.cyan('\n数据库迁移:'));
  console.log('  migrate create <name>  - 创建迁移文件');
  console.log('  migrate up             - 执行待运行的迁移');
  console.log('  migrate down           - 回滚最后一次迁移');
  console.log('  migrate status         - 查看迁移状态');

  console.log(chalk.cyan('\n查询分析与优化:'));
  console.log('  explain <chain-query>  - 查看查询执行计划');
  console.log('  suggest                - 建议缺失的索引');
  console.log('  slow [threshold]       - 显示慢查询 (默认100ms)');

  console.log(chalk.cyan('\n事务与批量操作:'));
  console.log('  begin                  - 开始事务');
  console.log('  commit                 - 提交事务');
  console.log('  rollback               - 回滚事务');
  console.log('  batch [query1, ...]    - 批量执行 (原子操作)');

  console.log(chalk.cyan('\nER图与文档:'));
  console.log('  schema [-o file.dot]   - 生成ER图 (DOT格式)');
  console.log('  doc [-o file.md]       - 生成数据库文档 (Markdown)');

  console.log(chalk.cyan('\n查询模板:'));
  console.log('  template create <name> <query>          - 创建参数化模板 (:param)');
  console.log('  template run <name> --param1=val1 ...   - 执行模板');
  console.log('  template list                            - 列出所有模板');

  console.log(chalk.cyan('\n导出与脚本:'));
  console.log('  export csv out.csv db.users.limit(5)  - 导出为CSV');
  console.log('  export json out.json db.users.limit(5) - 导出为JSON');
  console.log('  export md out.md db.users.limit(5)    - 导出为Markdown');
  console.log('  save <name> <query>                   - 保存脚本');
  console.log('  run <name>                            - 执行脚本');
  console.log('  scripts                               - 列出保存的脚本');
  console.log('  history                               - 显示历史查询');
  console.log('  .read <file>                          - 批量执行文件(.sql或.js)');

  console.log(chalk.cyan('\n其他:'));
  console.log('  help                  - 显示帮助');
  console.log('  exit                  - 退出程序');
  console.log();
}

function startREPL() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.green('db> ')
  });

  console.log(chalk.bold('\n╔════════════════════════════════════════════════════════════╗'));
  console.log(chalk.bold('║          SQLite 查询构建器 CLI - 交互式 REPL             ║'));
  console.log(chalk.bold('╚════════════════════════════════════════════════════════════╝'));
  console.log(chalk.gray('输入 help 查看帮助, exit 退出'));
  console.log();

  rl.prompt();

  rl.on('line', async (line) => {
    try {
      await executeCommand(line);
    } catch (e) {
      console.log(chalk.red(`错误: ${e.message}`));
    }
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(chalk.yellow('\n再见!'));
    savePersistentData();
    process.exit(0);
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2 || args[0] !== 'open') {
    console.log(chalk.red('用法: node querybuilder.js open DATABASE.db'));
    console.log(chalk.gray('\n示例:'));
    console.log('  node querybuilder.js open ecommerce.db');
    process.exit(1);
  }

  const dbFile = args[1];

  try {
    await openDatabase(dbFile);
    startREPL();
  } catch (e) {
    console.log(chalk.red(`无法打开数据库: ${e.message}`));
    process.exit(1);
  }
}

main();

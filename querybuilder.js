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
const historyFile = '.query_history.json';
const scriptsFile = '.saved_scripts.json';

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
}

function savePersistentData() {
  try {
    fs.writeFileSync(historyFile, JSON.stringify(history.slice(-100), null, 2));
    fs.writeFileSync(scriptsFile, JSON.stringify(savedScripts, null, 2));
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
      _updateData: this._updateData
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

  toSQL() {
    switch (this._operation) {
      case 'insert': return this._buildInsert();
      case 'update': return this._buildUpdate();
      case 'delete': return this._buildDelete();
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
      console.log(chalk.green(`\n✓ 查询成功 (${Date.now() - start}ms)`));
      printTable(rows);
      return rows;
    } else {
      const result = await runExec(sql, params);
      console.log(chalk.green(`\n✓ 操作成功 (${Date.now() - start}ms)`));
      if (this._operation === 'insert') {
        console.log(`  影响行数: ${result.changes}, 新记录ID: ${result.lastID}`);
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

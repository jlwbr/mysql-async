const mysql = require('mysql');
var retry = require('retry');

const { Promise } = global;
let config = {};
let debug = 0;
let slowQueryWarning = 500;
let pool;

function prepareQuery(query, parameters) {
  let sql = query;
  if (parameters !== null && typeof parameters === 'object') {
    sql = query.replace(/@(\w+)/g, (txt, key) => {
      let result = txt;
      if (Object.prototype.hasOwnProperty.call(parameters, key)) {
        result = mysql.escape(parameters[key]);
      } else if (Object.prototype.hasOwnProperty.call(parameters, `@${key}`)) {
        result = mysql.escape(parameters[`@${key}`]);
      }
      return result;
    });
  }
  return sql;
}

function typeCast(field, next) {
  let dateString = '';
  switch (field.type) {
    case 'DATETIME':
    case 'DATETIME2':
    case 'TIMESTAMP':
    case 'TIMESTAMP2':
    case 'NEWDATE':
    case 'DATE':
      dateString = field.string();
      if (field.type === 'DATE') dateString += ' 00:00:00';
      return (new Date(dateString)).getTime();
    case 'TINY':
      if (field.length === 1) {
        return (field.string() !== '0');
      }
      return next();
    case 'BIT':
      return Number(field.buffer()[0]);
    default:
      return next();
  }
}

function writeDebug(time, sql, resource) {
  const executionTime = time[0] * 1e3 + time[1] * 1e-6;
  if (slowQueryWarning && !debug && executionTime > slowQueryWarning) {
    console.log(`[MySQL] [Slow Query Warning] [${resource}] [${executionTime.toFixed()}ms] ${sql}`);
  }
  if (debug) console.log(`[MySQL] [${resource}] [${executionTime.toFixed()}ms] ${sql}`);
}

function safeInvoke(callback, args) {
  if (typeof callback === 'function') {
    setImmediate(() => {
      callback(args);
    });
  }
}

function execute(sql, invokingResource, connection) {
  const queryPromise = new Promise((resolve, reject) => {
    var operation = retry.operation({
      retries: 5,
      factor: 3,
      minTimeout: 1 * 1000,
      maxTimeout: 60 * 1000,
      randomize: true,
    });
    const start = process.hrtime();
    const db = connection || pool;
    operation.attempt(() => {
      db.query(sql, (error, result) => {
        writeDebug(process.hrtime(start), sql.sql, invokingResource);
        if (operation.retry(error)) return;
        if (error) reject(operation.mainError());
        resolve(result);
      })
    });
  });
  queryPromise.catch((error) => {
    console.log(`[ERROR] [MySQL] [${invokingResource}] An error happens on MySQL for query "${sql.sql}": ${error.message}`);
  });
  return queryPromise;
}

global.exports('mysql_execute', (query, parameters, callback) => {
  const invokingResource = global.GetInvokingResource();
  const sql = prepareQuery(query, parameters);
  execute({ sql, typeCast }, invokingResource).then((result) => {
    safeInvoke(callback, (result) ? result.affectedRows : 0);
  });
});

global.exports('mysql_fetch_all', (query, parameters, callback) => {
  const invokingResource = global.GetInvokingResource();
  const sql = prepareQuery(query, parameters);
  execute({ sql, typeCast }, invokingResource).then((result) => {
    safeInvoke(callback, result);
  });
});

global.exports('mysql_fetch_scalar', (query, parameters, callback) => {
  const invokingResource = global.GetInvokingResource();
  const sql = prepareQuery(query, parameters);
  execute({ sql, typeCast }, invokingResource).then((result) => {
    safeInvoke(callback, (result && result[0]) ? Object.values(result[0])[0] : null);
  });
});

global.exports('mysql_insert', (query, parameters, callback) => {
  const invokingResource = global.GetInvokingResource();
  const sql = prepareQuery(query, parameters);
  execute({ sql, typeCast }, invokingResource).then((result) => {
    safeInvoke(callback, (result) ? result.insertId : 0);
  });
});

// maybe remove this again
global.exports('mysql_reset_pool', () => {
  const oldPool = pool;
  pool = mysql.createPool(config);
  setTimeout(() => { oldPool.end(); }, 1000);
});

function parseOptions(settings, options) {
  const cfg = settings;
  const opts = options.split('&');
  opts.forEach((o) => {
    const keyValue = o.split('=');
    [, cfg[keyValue[0]]] = keyValue;
  });
  return cfg;
}

function parseConnectingString(connectionString) {
  let cfg = null;
  if (/(?:database|initial\scatalog)=(?:(.*?);|(.*))/gi.test(connectionString)) {
    let matches = (/(?:host|server|data\s?source|addr(?:ess)?)=(?:(.*?);|(.*))/gi.exec(connectionString));
    const host = (matches) ? matches[1] || matches[2] : 'localhost';
    matches = (/(?:Port)=(?:(.*?);|(.*))/gi.exec(connectionString));
    const port = (matches) ? matches[1] || matches[2] : 3306;
    matches = (/(?:user\s?(?:id|name)?|uid)=(?:(.*?);|(.*))/gi.exec(connectionString));
    const user = (matches) ? matches[1] || matches[2] : 'root';
    matches = (/(?:password|pwd)=(?:(.*?);|(.*))/gi.exec(connectionString));
    const password = (matches) ? matches[1] || matches[2] : '';
    matches = (/(?:database|initial\scatalog)=(?:(.*?);|(.*))/gi.exec(connectionString));
    const database = (matches) ? matches[1] || matches[2] : '';
    cfg = {
      host,
      port,
      user,
      password,
      database,
      supportBigNumbers: true,
      multipleStatements: true,
    };
  } else if (/mysql:\/\//gi.test(connectionString)) {
    const matches = /mysql:\/\/(.*?)(?::|@)(?:(.*)@)?(.*?)(?::(\d{1,5}))?\/(.*?)\?(.*)/gi.exec(connectionString);
    const host = (matches[3]) ? matches[3] : 'localhost';
    const port = (matches[4]) ? matches[4] : 3306;
    const user = (matches[1]) ? matches[1] : 'root';
    const password = (matches[2]) ? matches[2] : '';
    const database = (matches[5]) ? matches[5] : '';
    const settings = {
      host, port, user, password, database,
    };
    const options = matches[6];
    cfg = parseOptions(settings, options);
  } else throw new Error('No valid connection string found');

  return cfg;
}

let isReady = false;
let keepAliveSeconds = 0;

global.on('onServerResourceStart', (resourcename) => {
  if (resourcename === 'mysql-async') {
    // maybe default to addr=localhost;pwd=;database=essentialmode;uid=root
    const connectionString = global.GetConvar('mysql_connection_string', 'Empty');
    if (connectionString === 'Empty') throw new Error('Empty mysql_connection_string detected.');
    config = parseConnectingString(connectionString);
    debug = global.GetConvarInt('mysql_debug', 0);
    slowQueryWarning = global.GetConvarInt('mysql_slow_query_warning', 500);
    pool = mysql.createPool(config);
    global.emit('onMySQLReady'); // avoid ESX bugs
    isReady = true;

    keepAliveSeconds = global.GetConvarInt('mysql_keep_alive_seconds', 0);
    if (keepAliveSeconds > 0) {
      console.log('[MySQL] Enabling keep alive queries');
      keepAlive();
    }
  }
  if (isReady) {
    global.emit('MySQLReady'); // avoid ESX bugs
  }
});

function keepAlive() {
  if (!keepAliveSeconds || keepAliveSeconds <= 0) return; // Safeguard to stop when disabled

  execute({ sql: 'SELECT 1', typeCast }, 'keepAlive').then(() => {
    setTimeout(keepAlive, keepAliveSeconds * 1000);
  });
}

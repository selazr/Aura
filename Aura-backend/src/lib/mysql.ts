import mysql from "mysql2/promise";

export const mysqlPool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASS,
  database: process.env.MYSQL_DB, // aimotive
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

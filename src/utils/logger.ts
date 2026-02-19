import winston from "winston";
import path from "path";

const LOG_DIR = path.resolve(process.cwd(), "logs");

const timestampFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message }) => {
    return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  }),
);

const logger = winston.createLogger({
  level: "info",
  transports: [
    // errors + API failures only
    new winston.transports.File({
      filename: path.join(LOG_DIR, "error.log"),
      level: "error",
      format: timestampFormat,
    }),
    // everything
    new winston.transports.File({
      filename: path.join(LOG_DIR, "combined.log"),
      format: timestampFormat,
    }),
    // console output (keeps terminal behavior)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp({ format: "HH:mm:ss" }),
        winston.format.printf(({ timestamp, message }) => {
          return `[${timestamp}] ${message}`;
        }),
      ),
    }),
  ],
});

export default logger;

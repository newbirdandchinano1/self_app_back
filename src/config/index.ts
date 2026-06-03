import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',
};
export const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'self_app',
};

export const zhipuConfig = {
  apiKey:
    process.env.ZHIPU_API_KEY ||
    process.env.EXPO_PUBLIC_ZHIPU_API_KEY ||
    'd0ab5a5e402040d291d9b77f58996d32.nL1sXtGfaUMXzW7W',
  textModel: process.env.ZHIPU_TEXT_MODEL || 'glm-4-flash',
  visionModel: process.env.ZHIPU_VISION_MODEL || 'glm-4.6v-flash',
};

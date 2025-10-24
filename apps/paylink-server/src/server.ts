import "dotenv/config";
import { app } from "./app.js";
import { config } from "./config.js";

app.listen(config.port, () => {
  console.log(`X402 Proxy Server is running on port ${config.port}`);
  console.log(`Base URL: ${config.baseUrl}`);
});

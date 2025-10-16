import "dotenv/config";
import { app } from "./app";
import { config } from "./config";

app.listen(config.port, () => {
  console.log(`X402 Proxy Server is running on port ${config.port}`);
  console.log(`Base URL: ${config.baseUrl}`);
});

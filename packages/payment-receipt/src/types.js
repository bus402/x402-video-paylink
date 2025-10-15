"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isProofCarryingReceipt = isProofCarryingReceipt;
/**
 * Type guard to check if receipt is proof-carrying
 */
function isProofCarryingReceipt(receipt) {
    return "txHash" in receipt && typeof receipt.txHash === "string";
}
//# sourceMappingURL=types.js.map
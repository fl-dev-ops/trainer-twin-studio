import { encodeProto, type Seller } from "@/lib/billing/meteroid";

// Deliberately unlike the setup defaults: PDFs must use Meteroid's current company details.
export const seller: Seller = {
  name: "Updated Training Services Pvt Ltd", line1: "42 Learning Road", line2: "Suite 7, Tamil Nadu (33)",
  city: "Chennai", zip: "600042", state: "Tamil Nadu", country: "IN", gstin: "33ABCDE1234F1Z5", email: "accounts@updated.example", lutArn: "AD330000000000X",
};

export function grpcReply(message: Uint8Array = Buffer.alloc(0)) {
  const frame = (flag: number, payload: Uint8Array) => {
    const header = Buffer.alloc(5); header[0] = flag; header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
  };
  return Buffer.concat([frame(0, message), frame(0x80, Buffer.from("grpc-status:0\r\n"))]);
}

export function sellerReply(value: Seller = seller) {
  return grpcReply(encodeProto([[1, [
    [1, "entity-default"], [4, value.name], [11, value.lutArn], [14, value.line1], [15, value.line2], [16, value.zip],
    [17, value.state], [18, value.city], [19, value.gstin], [20, value.country], [41, value.email],
  ]]]));
}

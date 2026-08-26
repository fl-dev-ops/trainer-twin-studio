import { eveChannel } from "eve/channels/eve";
import { httpBasic, localDev } from "eve/channels/auth";

const secret = process.env.COPILOT_SERVICE_SECRET;

export default eveChannel({
  auth: secret
    ? [httpBasic({ username: "studio", password: secret }), localDev()]
    : [localDev()],
});

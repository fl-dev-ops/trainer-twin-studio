import { eveChannel } from "eve/channels/eve";
import { type AuthFn, localDev } from "eve/channels/auth";
import { studioPrincipal } from "../lib/auth";

function studioOrganization(): AuthFn<Request> {
  return (request) => studioPrincipal(request);
}

export default eveChannel({
  auth: [studioOrganization(), localDev()],
});

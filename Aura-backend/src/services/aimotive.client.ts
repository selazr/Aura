import axios from "axios";

const baseURL = process.env.AIMOTIVE_API_URL;
const apiKey = process.env.AIMOTIVE_API_KEY;

if (!baseURL || !/^https?:\/\//.test(baseURL)) {
  throw new Error(
    `AIMOTIVE_API_URL inválida: "${baseURL}". Debe incluir http/https`
  );
}

if (!apiKey) {
  throw new Error("Falta AIMOTIVE_API_KEY en .env");
}

export const aimotiveClient = axios.create({
  baseURL,
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  timeout: 10000,
});

export async function sendConversationMessage(
  instanceId: string,
  conversationId: string,
  message: string
) {
  const res = await aimotiveClient.put(
    `/v1/messaging/${instanceId}/conversation/${conversationId}`,
    { body: message }
  );

  return res.data;
}

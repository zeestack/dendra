// Generative-UI chat. The assistant streams typed PARTS; text renders as chat
// bubbles and each tool result renders a real React component (see
// components/cards.tsx). All the chat logic lives in components/ — this page is
// just the mount point.

import { AssistantChat } from "./components/AssistantChat";

export default function AssistantPage() {
  return <AssistantChat />;
}

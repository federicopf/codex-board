import Ionicons from "@expo/vector-icons/Ionicons";
import type { ComponentProps } from "react";

export function MobileIcon({ name, size = 20, color }: {
  name: ComponentProps<typeof Ionicons>["name"];
  size?: number;
  color: string;
}) {
  return <Ionicons name={name} size={size} color={color} />;
}

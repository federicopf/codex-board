import Feather from "@expo/vector-icons/Feather";
import type { ComponentProps } from "react";

export function MobileIcon({ name, size = 22, color }: {
  name: ComponentProps<typeof Feather>["name"];
  size?: number;
  color: string;
}) {
  return <Feather name={name} size={size} color={color} allowFontScaling={false} accessible={false} style={{ lineHeight: size }} />;
}

import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { MobileIcon } from "./MobileIcon";
import { colors } from "./theme";

export function MobileNavigation({ unreadCount, onProjects, onInbox, onAutomations, onSettings }: {
  unreadCount: number;
  onProjects: () => void;
  onInbox: () => void;
  onAutomations: () => void;
  onSettings: () => void;
}) {
  const compact=useWindowDimensions().height<500;
  return <View style={[styles.bar,compact&&styles.compact]}>
    <Pressable style={[styles.item,compact&&styles.compactItem]} onPress={onProjects} accessibilityRole="button" accessibilityLabel="Projects"><MobileIcon name="folder-outline" color={colors.primary}/><Text style={[styles.label,styles.active]}>Projects</Text></Pressable>
    <Pressable style={[styles.item,compact&&styles.compactItem]} onPress={onInbox} accessibilityRole="button" accessibilityLabel={`Inbox, ${unreadCount} unread`}><View><MobileIcon name="mail-outline" color={colors.textMuted}/>{unreadCount>0&&<View style={styles.badge}><Text style={styles.badgeText}>{unreadCount>99?"99+":unreadCount}</Text></View>}</View><Text style={styles.label}>Inbox</Text></Pressable>
    <Pressable style={[styles.item,compact&&styles.compactItem]} onPress={onAutomations} accessibilityRole="button"><MobileIcon name="flash-outline" color={colors.textMuted}/><Text style={styles.label}>Workflows</Text></Pressable>
    <Pressable style={[styles.item,compact&&styles.compactItem]} onPress={onSettings} accessibilityRole="button"><MobileIcon name="settings-outline" color={colors.textMuted}/><Text style={styles.label}>Settings</Text></Pressable>
  </View>;
}

const styles=StyleSheet.create({
  bar:{flexDirection:"row",paddingVertical:6,paddingHorizontal:8,borderTopWidth:StyleSheet.hairlineWidth,borderColor:colors.border,backgroundColor:colors.surface},
  compact:{paddingVertical:0},compactItem:{minHeight:44,flexDirection:"row",gap:7},
  item:{flex:1,minHeight:56,alignItems:"center",justifyContent:"center",gap:5},label:{color:colors.textMuted,fontSize:11,fontWeight:"600"},active:{color:colors.primary},
  badge:{position:"absolute",right:-12,top:-7,minWidth:17,paddingHorizontal:4,height:17,alignItems:"center",justifyContent:"center",borderRadius:9,backgroundColor:colors.danger},badgeText:{color:"white",fontSize:9,fontWeight:"700"},
});

import { useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MobileIcon } from "./MobileIcon";
import { colors } from "./theme";
import type { ComponentProps } from "react";

export interface MobileAction {
  label: string;
  icon: ComponentProps<typeof MobileIcon>["name"];
  onPress: () => void;
  destructive?: boolean;
}

export function MobileActionSheet({ title, actions, onClose }: { title: string; actions: MobileAction[]; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [visible,setVisible] = useState(true);
  const deferredAction = useRef<(() => void) | null>(null);
  function select(action: MobileAction) {
    if (Platform.OS === "ios") {
      // Wait for this native presenter to dismiss before opening the next sheet.
      deferredAction.current = action.onPress;
      setVisible(false);
    } else { onClose(); action.onPress(); }
  }
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} onDismiss={()=>{
    const action=deferredAction.current;
    if(action) { deferredAction.current=null;onClose();action(); }
  }}>
    <View style={styles.backdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Dismiss actions"/>
      <View accessibilityViewIsModal style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <View style={styles.heading}><Text style={styles.title} numberOfLines={2}>{title}</Text><Pressable onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel="Close actions"><MobileIcon name="x" color={colors.text} size={23}/></Pressable></View>
        <ScrollView keyboardShouldPersistTaps="handled">{actions.map(action=><Pressable key={action.label} accessibilityRole="button" style={({pressed})=>[styles.action, pressed&&styles.pressed]} onPress={()=>select(action)}>
          <MobileIcon name={action.icon} color={action.destructive?colors.danger:colors.textMuted}/><Text style={[styles.label,action.destructive&&styles.danger]}>{action.label}</Text>
        </Pressable>)}</ScrollView>
      </View>
    </View>
  </Modal>;
}

const styles=StyleSheet.create({
  backdrop:{flex:1,justifyContent:"flex-end",backgroundColor:"rgba(18,20,28,.42)"},
  sheet:{maxHeight:"85%",paddingHorizontal:20,borderTopLeftRadius:24,borderTopRightRadius:24,backgroundColor:colors.surface},
  heading:{minHeight:76,flexDirection:"row",alignItems:"center",gap:16,borderBottomWidth:StyleSheet.hairlineWidth,borderColor:colors.border,marginBottom:8},
  title:{flex:1,minWidth:0,color:colors.text,fontSize:17,lineHeight:23,fontWeight:"700"},close:{width:48,height:48,alignItems:"center",justifyContent:"center"},
  action:{minHeight:56,flexDirection:"row",alignItems:"center",gap:16,paddingHorizontal:8,borderRadius:12},pressed:{backgroundColor:colors.surfaceMuted},label:{flex:1,color:colors.text,fontSize:15,fontWeight:"500"},danger:{color:colors.danger},
});

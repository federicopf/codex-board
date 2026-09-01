import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import { formatCodexDirectives } from "@codex-board/protocol";
import type { BoardNotification } from "@codex-board/protocol";
import { colors, radius, shadows, spacing } from "./theme";

export function AutomationResultModal({ notification, onClose, onOpenThread }: {
  notification: BoardNotification;
  onClose: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const result = notification.automation;
  if (!result) return null;
  const failed = result.status === "failed";
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.dialog}>
          <View style={styles.header}>
            <View style={[styles.statusIcon,failed&&styles.statusIconFailed]}><Text style={[styles.statusSymbol,failed&&styles.statusSymbolFailed]}>{failed?"!":"✓"}</Text></View>
            <View style={styles.headerCopy}><Text style={styles.eyebrow}>AUTOMATION RESULT</Text><Text style={styles.title}>{result.name}</Text><Text style={styles.meta}>{failed?"Finished with an error":"Completed successfully"}{result.durationMs?` · ${Math.max(1,Math.round(result.durationMs/1000))}s`:""}</Text></View>
            <Pressable style={styles.close} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close result"><Text style={styles.closeText}>×</Text></Pressable>
          </View>
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}><Markdown style={markdownStyles}>{formatCodexDirectives(result.result)}</Markdown></ScrollView>
          <View style={styles.footer}>
            <Pressable style={styles.secondary} onPress={onClose}><Text style={styles.secondaryText}>Close</Text></Pressable>
            {notification.threadId?<Pressable style={styles.primary} onPress={()=>onOpenThread(notification.threadId!)}><Text style={styles.primaryText}>Open conversation</Text></Pressable>:null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles=StyleSheet.create({
  backdrop:{flex:1,padding:spacing.lg,justifyContent:"center",backgroundColor:"rgba(18,20,27,.56)"},
  dialog:{maxHeight:"78%",overflow:"hidden",borderRadius:radius.xl,backgroundColor:colors.surface,...shadows.card},
  header:{padding:spacing.lg,flexDirection:"row",alignItems:"center",gap:spacing.md,borderBottomWidth:StyleSheet.hairlineWidth,borderColor:colors.border},
  statusIcon:{width:42,height:42,alignItems:"center",justifyContent:"center",borderRadius:13,backgroundColor:"#E8F8F0"},statusIconFailed:{backgroundColor:"#FFF0ED"},statusSymbol:{color:colors.success,fontSize:18,fontWeight:"800"},statusSymbolFailed:{color:colors.danger},
  headerCopy:{minWidth:0,flex:1},eyebrow:{color:colors.primary,fontSize:8,fontWeight:"800",letterSpacing:1},title:{marginTop:4,color:colors.text,fontSize:18,fontWeight:"800",letterSpacing:-.5},meta:{marginTop:4,color:colors.textMuted,fontSize:9},close:{width:36,height:36,alignItems:"center",justifyContent:"center",borderRadius:11,backgroundColor:colors.surfaceMuted},closeText:{color:colors.textMuted,fontSize:23,lineHeight:25},
  body:{maxHeight:390},bodyContent:{padding:spacing.xl},footer:{padding:spacing.md,flexDirection:"row",justifyContent:"flex-end",gap:spacing.sm,borderTopWidth:StyleSheet.hairlineWidth,borderColor:colors.border},secondary:{minHeight:42,paddingHorizontal:spacing.lg,alignItems:"center",justifyContent:"center",borderWidth:1,borderColor:colors.border,borderRadius:radius.md},secondaryText:{color:colors.text,fontSize:11,fontWeight:"700"},primary:{minHeight:42,paddingHorizontal:spacing.lg,alignItems:"center",justifyContent:"center",borderRadius:radius.md,backgroundColor:colors.ink},primaryText:{color:"white",fontSize:11,fontWeight:"700"},
});

const markdownStyles=StyleSheet.create({body:{color:colors.text,fontSize:13,lineHeight:20},paragraph:{marginTop:0,marginBottom:8},heading1:{color:colors.text,fontSize:18,fontWeight:"800"},heading2:{color:colors.text,fontSize:16,fontWeight:"800"},bullet_list:{marginVertical:4},ordered_list:{marginVertical:4},code_inline:{color:"#3E4380",backgroundColor:colors.surfaceMuted},fence:{padding:10,borderRadius:10,color:"white",backgroundColor:colors.ink}});

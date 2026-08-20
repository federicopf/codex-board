import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { QueuedMessage, ThreadDto } from "@codex-board/protocol";
import { colors, radius, shadows, spacing } from "./theme";

export interface MobileCategory {
  name: string;
  count: number;
}

interface MobileBoardHomeProps {
  connected: boolean;
  loading: boolean;
  projectLabel: string;
  totalCount: number;
  workingCount: number;
  unreadCount: number;
  categories: MobileCategory[];
  activeCategory: string;
  threads: ThreadDto[];
  queues: Record<string, QueuedMessage[]>;
  search: string;
  isWorking: (thread: ThreadDto) => boolean;
  titleFor: (thread: ThreadDto) => string;
  projectFor: (thread: ThreadDto) => string;
  onSearch: (value: string) => void;
  onProject: () => void;
  onCategory: (category: string) => void;
  onOpen: (thread: ThreadDto) => void;
  onMove: (thread: ThreadDto) => void;
  onNewTask: () => void;
  onInbox: () => void;
  onAutomations: () => void;
  onSettings: () => void;
}

function Logo() {
  return <View style={styles.logo}><View style={[styles.logoBar,{height:8}]} /><View style={[styles.logoBar,{height:17}]} /><View style={[styles.logoBar,{height:12}]} /></View>;
}

function TaskCard({ thread, queueCount, working, title, project, onOpen, onMove }: { thread: ThreadDto; queueCount: number; working: boolean; title: string; project: string; onOpen: () => void; onMove: () => void }) {
  return (
    <View style={[styles.card,working&&styles.workingCard]}>
      <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel={`Open ${title}`}>
        <View style={styles.cardTop}><Text style={styles.projectPill} numberOfLines={1}>{project}</Text>{working&&<View style={styles.workingPill}><View style={styles.liveDot}/><Text style={styles.workingPillText}>Working</Text></View>}</View>
        <Text style={styles.cardTitle}>{title}</Text>
        {thread.preview ? <Text style={styles.cardPreview} numberOfLines={2}>{thread.preview}</Text> : null}
      </Pressable>
      <View style={styles.cardFooter}>
        <Text style={[styles.cardMeta,working&&styles.cardMetaLive]}>{queueCount ? `${queueCount} queued` : working ? "Codex is working" : "Ready"}</Text>
        <Pressable style={styles.moveButton} onPress={onMove} accessibilityRole="button" accessibilityLabel={`Move ${title}`}><Text style={styles.moveIcon}>↔</Text><Text style={styles.moveText}>Move</Text></Pressable>
        <Pressable style={styles.openButton} onPress={onOpen}><Text style={styles.openButtonText}>Open</Text><Text style={styles.openArrow}>→</Text></Pressable>
      </View>
    </View>
  );
}

export function MobileBoardHome(props: MobileBoardHomeProps) {
  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <View style={styles.brand}><Logo/><View><Text style={styles.brandTitle}>Codex Board</Text><View style={styles.connection}><View style={[styles.connectionDot,{backgroundColor:props.connected?colors.success:colors.warning}]}/><Text style={styles.connectionText}>{props.connected?"Connected to your PC":"Reconnecting…"}</Text></View></View></View>
        <Pressable style={styles.newButton} onPress={props.onNewTask} accessibilityRole="button" accessibilityLabel="New Codex task"><Text style={styles.newButtonIcon}>＋</Text></Pressable>
      </View>

      <View style={styles.overview}>
        <View><Text style={styles.eyebrow}>CURRENT WORKSPACE</Text><Text style={styles.overviewTitle}>{props.projectLabel}</Text><Text style={styles.overviewSubtitle}>{props.totalCount} active {props.totalCount===1?"task":"tasks"}</Text></View>
        <View style={[styles.liveMetric,props.workingCount>0&&styles.liveMetricActive]}><View style={styles.metricRow}><View style={[styles.metricDot,props.workingCount>0&&styles.metricDotActive]}/><Text style={styles.metricNumber}>{props.workingCount}</Text></View><Text style={styles.metricLabel}>working now</Text></View>
      </View>

      <View style={styles.controls}>
        <Pressable style={styles.projectControl} onPress={props.onProject}><View><Text style={styles.controlLabel}>PROJECT</Text><Text style={styles.controlValue} numberOfLines={1}>{props.projectLabel}</Text></View><Text style={styles.chevron}>⌄</Text></Pressable>
        <View style={styles.searchControl}><Text style={styles.searchIcon}>⌕</Text><TextInput style={styles.searchInput} value={props.search} onChangeText={props.onSearch} placeholder="Search tasks" placeholderTextColor={colors.textSoft}/>{props.search?<Pressable onPress={()=>props.onSearch("")}><Text style={styles.clearSearch}>×</Text></Pressable>:null}</View>
      </View>

      <ScrollView horizontal style={styles.tabsScroll} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>{props.categories.map(category=>{const active=category.name===props.activeCategory;return <Pressable key={category.name} style={[styles.tab,active&&styles.tabActive]} onPress={()=>props.onCategory(category.name)}><Text style={[styles.tabText,active&&styles.tabTextActive]}>{category.name}</Text><Text style={[styles.tabCount,active&&styles.tabCountActive]}>{category.count}</Text></Pressable>})}</ScrollView>

      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={props.threads}
        keyExtractor={thread=>thread.id}
        ListHeaderComponent={<View style={styles.listHeader}><View><Text style={styles.listTitle}>{props.activeCategory||"Tasks"}</Text><Text style={styles.listSubtitle}>{props.search?`Results for “${props.search}”`:"Your current stage"}</Text></View><Text style={styles.listCount}>{props.threads.length}</Text></View>}
        ListEmptyComponent={<View style={styles.empty}>{props.loading?<><ActivityIndicator color={colors.primary}/><Text style={styles.emptyText}>Loading your workspace…</Text></>:<><View style={styles.emptyIcon}><Text>⌕</Text></View><Text style={styles.emptyTitle}>No tasks found</Text><Text style={styles.emptyText}>{props.search?"Try a different search.":"This stage has no tasks for the selected project."}</Text></>}</View>}
        renderItem={({item})=><TaskCard thread={item} queueCount={props.queues[item.id]?.length||0} working={props.isWorking(item)} title={props.titleFor(item)} project={props.projectFor(item)} onOpen={()=>props.onOpen(item)} onMove={()=>props.onMove(item)}/>} />

      <View style={styles.bottomNav}>
        <Pressable style={styles.navItem} accessibilityRole="button" accessibilityState={{selected:true}}><Text style={[styles.navIcon,styles.navIconActive]}>⌂</Text><Text style={[styles.navLabel,styles.navLabelActive]}>Board</Text></Pressable>
        <Pressable style={styles.navItem} onPress={props.onInbox} accessibilityRole="button" accessibilityLabel="Inbox"><View><Text style={styles.navIcon}>◇</Text>{props.unreadCount>0&&<View style={styles.badge}><Text style={styles.badgeText}>{props.unreadCount}</Text></View>}</View><Text style={styles.navLabel}>Inbox</Text></Pressable>
        <Pressable style={styles.navItem} onPress={props.onAutomations} accessibilityRole="button" accessibilityLabel="Automations"><Text style={styles.navIcon}>⚡</Text><Text style={styles.navLabel}>Automate</Text></Pressable>
        <Pressable style={styles.navItem} onPress={props.onSettings} accessibilityRole="button" accessibilityLabel="Settings"><Text style={styles.navIcon}>☰</Text><Text style={styles.navLabel}>Settings</Text></Pressable>
      </View>
    </View>
  );
}

const styles=StyleSheet.create({
  page:{flex:1,backgroundColor:colors.background},
  header:{minHeight:70,paddingHorizontal:spacing.lg,flexDirection:"row",alignItems:"center",justifyContent:"space-between",borderBottomWidth:StyleSheet.hairlineWidth,borderColor:colors.border,backgroundColor:colors.surface},
  brand:{flexDirection:"row",alignItems:"center",gap:10},logo:{width:36,height:36,padding:8,borderRadius:11,flexDirection:"row",alignItems:"flex-end",gap:3,backgroundColor:colors.ink},logoBar:{flex:1,borderRadius:2,backgroundColor:"white"},brandTitle:{color:colors.text,fontSize:16,fontWeight:"800",letterSpacing:-.4},connection:{marginTop:3,flexDirection:"row",alignItems:"center",gap:5},connectionDot:{width:6,height:6,borderRadius:3},connectionText:{color:colors.textMuted,fontSize:9,fontWeight:"600"},newButton:{width:40,height:40,alignItems:"center",justifyContent:"center",borderRadius:12,backgroundColor:colors.ink},newButtonIcon:{color:"white",fontSize:20,lineHeight:22},
  overview:{paddingHorizontal:spacing.xl,paddingTop:spacing.xl,paddingBottom:spacing.lg,flexDirection:"row",alignItems:"center",justifyContent:"space-between"},eyebrow:{color:colors.primary,fontSize:8,fontWeight:"800",letterSpacing:1.2},overviewTitle:{maxWidth:240,marginTop:5,color:colors.text,fontSize:25,lineHeight:30,fontWeight:"800",letterSpacing:-.9},overviewSubtitle:{marginTop:4,color:colors.textMuted,fontSize:11},liveMetric:{minWidth:75,padding:10,alignItems:"center",borderWidth:1,borderColor:colors.border,borderRadius:radius.md,backgroundColor:colors.surface},liveMetricActive:{borderColor:"#B8E5CF",backgroundColor:"#ECF9F3"},metricRow:{flexDirection:"row",alignItems:"center",gap:5},metricDot:{width:7,height:7,borderRadius:4,backgroundColor:"#B1B5BF"},metricDotActive:{backgroundColor:colors.success},metricNumber:{color:colors.text,fontSize:17,fontWeight:"800"},metricLabel:{marginTop:2,color:colors.textMuted,fontSize:8,fontWeight:"600"},
  controls:{paddingHorizontal:spacing.lg,flexDirection:"row",gap:spacing.sm},projectControl:{height:48,flex:1.05,paddingHorizontal:12,flexDirection:"row",alignItems:"center",justifyContent:"space-between",borderWidth:1,borderColor:colors.border,borderRadius:radius.md,backgroundColor:colors.surface},controlLabel:{color:colors.textSoft,fontSize:7,fontWeight:"800",letterSpacing:.8},controlValue:{maxWidth:120,marginTop:3,color:colors.text,fontSize:11,fontWeight:"700"},chevron:{color:colors.primary,fontSize:17},searchControl:{height:48,flex:1,flexDirection:"row",alignItems:"center",gap:7,paddingHorizontal:11,borderWidth:1,borderColor:colors.border,borderRadius:radius.md,backgroundColor:colors.surface},searchIcon:{color:colors.textMuted,fontSize:19,transform:[{rotate:"-12deg"}]},searchInput:{minWidth:0,flex:1,color:colors.text,fontSize:11},clearSearch:{color:colors.textMuted,fontSize:18},
  tabsScroll:{flexGrow:0,flexShrink:0,height:58},tabs:{height:58,paddingHorizontal:spacing.lg,paddingVertical:10,alignItems:"center",gap:7},tab:{height:38,paddingLeft:13,paddingRight:6,flexDirection:"row",alignItems:"center",gap:8,borderWidth:1,borderColor:colors.border,borderRadius:radius.pill,backgroundColor:colors.surface},tabActive:{borderColor:colors.ink,backgroundColor:colors.ink},tabText:{color:colors.textMuted,fontSize:11,fontWeight:"700"},tabTextActive:{color:"white"},tabCount:{minWidth:24,height:24,textAlign:"center",textAlignVertical:"center",borderRadius:12,overflow:"hidden",color:colors.textMuted,backgroundColor:colors.surfaceMuted,fontSize:9,fontWeight:"800"},tabCountActive:{color:colors.ink,backgroundColor:"white"},
  list:{flex:1},listContent:{paddingHorizontal:spacing.lg,paddingBottom:92},listHeader:{minHeight:50,flexDirection:"row",alignItems:"center",justifyContent:"space-between",paddingHorizontal:2},listTitle:{color:colors.text,fontSize:14,fontWeight:"800"},listSubtitle:{marginTop:2,color:colors.textMuted,fontSize:9},listCount:{minWidth:27,height:27,textAlign:"center",textAlignVertical:"center",borderRadius:14,overflow:"hidden",color:colors.textMuted,backgroundColor:colors.surfaceMuted,fontSize:10,fontWeight:"800"},
  card:{marginBottom:10,padding:14,borderWidth:1,borderColor:colors.border,borderRadius:radius.lg,backgroundColor:colors.surface,...shadows.card},workingCard:{borderColor:"#AEB1F4",borderLeftWidth:4},cardTop:{minHeight:22,marginBottom:8,flexDirection:"row",alignItems:"center",justifyContent:"space-between"},projectPill:{maxWidth:"68%",paddingHorizontal:7,paddingVertical:4,borderRadius:6,overflow:"hidden",color:colors.textMuted,backgroundColor:colors.surfaceMuted,fontSize:8,fontWeight:"700"},workingPill:{paddingHorizontal:7,paddingVertical:4,flexDirection:"row",alignItems:"center",gap:4,borderRadius:8,backgroundColor:colors.primarySoft},liveDot:{width:5,height:5,borderRadius:3,backgroundColor:colors.primary},workingPillText:{color:colors.primary,fontSize:8,fontWeight:"800"},cardTitle:{color:colors.text,fontSize:16,lineHeight:21,fontWeight:"700",letterSpacing:-.25},cardPreview:{marginTop:7,color:colors.textMuted,fontSize:12,lineHeight:18},cardFooter:{marginTop:13,paddingTop:10,flexDirection:"row",alignItems:"center",gap:7,borderTopWidth:StyleSheet.hairlineWidth,borderColor:colors.border},cardMeta:{flex:1,color:colors.textSoft,fontSize:9,fontWeight:"600"},cardMetaLive:{color:colors.primary},moveButton:{height:31,paddingHorizontal:8,flexDirection:"row",alignItems:"center",gap:4,borderRadius:8,backgroundColor:colors.surfaceMuted},moveIcon:{color:colors.textMuted,fontSize:13},moveText:{color:colors.textMuted,fontSize:9,fontWeight:"700"},openButton:{height:31,paddingHorizontal:10,flexDirection:"row",alignItems:"center",gap:5,borderRadius:8,backgroundColor:colors.primarySoft},openButtonText:{color:colors.primary,fontSize:9,fontWeight:"800"},openArrow:{color:colors.primary,fontSize:14},
  empty:{minHeight:260,alignItems:"center",justifyContent:"center"},emptyIcon:{width:50,height:50,alignItems:"center",justifyContent:"center",borderRadius:16,backgroundColor:colors.primarySoft},emptyTitle:{marginTop:12,color:colors.text,fontSize:15,fontWeight:"800"},emptyText:{maxWidth:230,marginTop:5,textAlign:"center",color:colors.textMuted,fontSize:11,lineHeight:17},
  bottomNav:{position:"absolute",left:0,right:0,bottom:0,height:72,paddingHorizontal:12,paddingTop:7,paddingBottom:5,flexDirection:"row",alignItems:"center",justifyContent:"space-around",borderTopWidth:StyleSheet.hairlineWidth,borderColor:colors.border,backgroundColor:"rgba(255,255,255,.98)"},navItem:{width:70,height:54,alignItems:"center",justifyContent:"center",gap:3,borderRadius:12},navIcon:{color:colors.textMuted,fontSize:18},navIconActive:{color:colors.primary},navLabel:{color:colors.textMuted,fontSize:8,fontWeight:"700"},navLabelActive:{color:colors.primary},badge:{position:"absolute",top:-5,right:-10,minWidth:16,height:16,paddingHorizontal:3,alignItems:"center",justifyContent:"center",borderRadius:8,backgroundColor:colors.danger},badgeText:{color:"white",fontSize:7,fontWeight:"800"},
});

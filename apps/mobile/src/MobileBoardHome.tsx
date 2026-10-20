import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import type { QueuedMessage, ThreadDto } from "@codex-board/protocol";
import { colors } from "./theme";
import { MobileIcon } from "./MobileIcon";
import { MobileActionSheet } from "./MobileActionSheet";

export interface MobileCategory { name: string; count: number; }
interface MobileBoardHomeProps {
  connected: boolean;
  loading: boolean;
  refreshing: boolean;
  projectLabel: string;
  showProject: boolean;
  totalCount: number;
  workingCount: number;
  categories: MobileCategory[];
  activeCategory: string;
  threads: ThreadDto[];
  queues: Record<string, QueuedMessage[]>;
  search: string;
  isWorking: (thread: ThreadDto) => boolean;
  titleFor: (thread: ThreadDto) => string;
  projectFor: (thread: ThreadDto) => string;
  onSearch: (value: string) => void;
  onBackToProjects: () => void;
  onCategory: (category: string) => void;
  onOpen: (thread: ThreadDto) => void;
  onMove: (thread: ThreadDto) => void;
  onFork: (thread: ThreadDto) => void;
  onRename: (thread: ThreadDto) => void;
  onArchive: (thread: ThreadDto) => void;
  onStop: (thread: ThreadDto) => void;
  onNewTask: () => void;
  onRefresh: () => void;
}

export function MobileBoardHome(props: MobileBoardHomeProps) {
  const compact = useWindowDimensions().height < 500;
  const [actionThread, setActionThread] = useState<ThreadDto | null>(null);
  return <View style={styles.page}>
    <View style={[styles.header,compact&&styles.compactHeader]}>
      <Pressable style={styles.iconButton} onPress={props.onBackToProjects} accessibilityRole="button" accessibilityLabel="Back to projects"><MobileIcon name="chevron-left" size={25} color={colors.text}/></Pressable>
      <View style={styles.heading}><Text style={styles.title} numberOfLines={1}>{props.projectLabel}</Text><Text style={styles.subtitle}>{props.totalCount} tasks{props.workingCount?` · ${props.workingCount} working`:""}{!props.connected?" · Reconnecting…":""}</Text></View>
      <Pressable style={[styles.iconButton,styles.newButton]} onPress={props.onNewTask} accessibilityRole="button" accessibilityLabel="New task"><MobileIcon name="plus" size={24} color="white"/></Pressable>
    </View>
    <View style={[styles.search,compact&&styles.compactSearch]}>
      <MobileIcon name="search" color={colors.textMuted}/>
      <TextInput value={props.search} onChangeText={props.onSearch} style={styles.searchInput} placeholder="Search this project" placeholderTextColor={colors.textSoft} returnKeyType="search"/>
      {props.search?<Pressable style={styles.clearSearch} onPress={()=>props.onSearch("")} accessibilityRole="button" accessibilityLabel="Clear search"><MobileIcon name="x-circle" color={colors.textMuted}/></Pressable>:null}
    </View>
    {!props.search.trim()&&props.categories.length>0&&<ScrollView horizontal style={[styles.categoryScroll,compact&&{maxHeight:48}]} contentContainerStyle={[styles.categories,compact&&{paddingVertical:4}]} showsHorizontalScrollIndicator={false}>{props.categories.map(category=>{
      const active=category.name===props.activeCategory;
      return <Pressable key={category.name} style={[styles.category,compact&&{minHeight:40},active&&styles.categoryActive]} onPress={()=>props.onCategory(category.name)} accessibilityRole="button" accessibilityState={{selected:active}}><Text style={[styles.categoryText,active&&styles.categoryTextActive]}>{category.name}</Text><Text style={[styles.categoryCount,active&&styles.categoryTextActive]}>{category.count}</Text></Pressable>;
    })}</ScrollView>}
    <FlatList data={props.threads} keyExtractor={thread=>thread.id} style={styles.list} contentContainerStyle={styles.listContent}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" refreshing={props.refreshing} onRefresh={props.onRefresh}
      ListHeaderComponent={props.search.trim()?<Text style={styles.results}>{props.threads.length} results across this project</Text>:null}
      ListEmptyComponent={<View style={styles.empty}>{props.loading?<ActivityIndicator color={colors.primary}/>:<MobileIcon name={props.search?"search":"message-square"} size={32} color={colors.textSoft}/>}<Text style={styles.emptyTitle}>{props.loading?"Loading conversations…":props.search?"No matching conversations":"No tasks here yet"}</Text><Text style={styles.emptyText}>{props.search?"Try another title or phrase.":"Start a task in this project to begin."}</Text>{!props.loading&&!props.search&&<Pressable onPress={props.onNewTask} style={styles.emptyAction}><Text style={styles.emptyActionText}>Create a task</Text></Pressable>}</View>}
      renderItem={({item})=>{
        const working=props.isWorking(item);
        const queued=props.queues[item.id]?.length||0;
        return <View style={[styles.card,working&&styles.workingCard]}>
          <Pressable style={styles.cardMain} onPress={()=>props.onOpen(item)} onLongPress={()=>setActionThread(item)} accessibilityRole="button" accessibilityLabel={`Open ${props.titleFor(item)}`}>
            <View style={styles.cardMeta}>{props.showProject&&<Text numberOfLines={1} style={styles.project}>{props.projectFor(item)}</Text>}<View style={[styles.statusDot,working&&styles.statusDotLive]}/><Text style={[styles.status,working&&styles.statusLive]}>{working?"Working":"Ready"}{queued?` · ${queued} queued`:""}</Text></View>
            <Text style={styles.cardTitle} numberOfLines={2}>{props.titleFor(item)}</Text>
            {item.preview?<Text style={styles.preview} numberOfLines={2}>{item.preview}</Text>:null}
          </Pressable>
          <Pressable style={styles.moreButton} onPress={()=>setActionThread(item)} accessibilityRole="button" accessibilityLabel={`Actions for ${props.titleFor(item)}`}><MobileIcon name="more-horizontal" color={colors.textMuted}/></Pressable>
        </View>;
      }}/>
    {actionThread&&<MobileActionSheet title={props.titleFor(actionThread)} onClose={()=>setActionThread(null)} actions={[
      {label:"Rename conversation",icon:"edit-2",onPress:()=>props.onRename(actionThread)},
      {label:"Move to category",icon:"repeat",onPress:()=>props.onMove(actionThread)},
      {label:"Fork conversation",icon:"git-branch",onPress:()=>props.onFork(actionThread)},
      ...(props.isWorking(actionThread)?[{label:"Stop Codex",icon:"stop-circle" as const,onPress:()=>props.onStop(actionThread)}]:[]),
      {label:"Archive conversation",icon:"archive",destructive:true,onPress:()=>props.onArchive(actionThread)},
    ]}/>}
  </View>;
}

const styles=StyleSheet.create({
  page:{flex:1,backgroundColor:colors.background},header:{minHeight:84,paddingHorizontal:12,paddingVertical:12,flexDirection:"row",alignItems:"center",gap:10,backgroundColor:colors.surface},
  compactHeader:{minHeight:60,paddingVertical:6},compactSearch:{marginTop:8,marginBottom:4,minHeight:44},
  iconButton:{width:48,height:48,flexShrink:0,alignItems:"center",justifyContent:"center",borderRadius:15},newButton:{backgroundColor:colors.ink},heading:{flex:1,minWidth:0},title:{fontSize:21,fontWeight:"700",letterSpacing:-.5,color:colors.text},subtitle:{marginTop:5,fontSize:12,color:colors.textMuted},
  search:{margin:16,marginBottom:8,minHeight:48,paddingLeft:14,flexDirection:"row",alignItems:"center",gap:10,borderWidth:1,borderColor:colors.border,borderRadius:14,backgroundColor:colors.surface},searchInput:{flex:1,minWidth:0,paddingVertical:12,paddingRight:8,color:colors.text,fontSize:14},clearSearch:{width:44,height:44,alignItems:"center",justifyContent:"center"},
  categoryScroll:{flexGrow:0,flexShrink:0,maxHeight:64},categories:{paddingHorizontal:16,paddingVertical:8,gap:8},category:{minHeight:44,paddingHorizontal:14,flexDirection:"row",alignItems:"center",gap:9,borderRadius:14,backgroundColor:colors.surface},categoryActive:{backgroundColor:colors.ink},categoryText:{fontSize:13,fontWeight:"600",color:colors.textMuted},categoryTextActive:{color:"white"},categoryCount:{fontSize:12,color:colors.textSoft},
  list:{flex:1},listContent:{padding:16,paddingTop:8,paddingBottom:24,flexGrow:1},results:{marginBottom:14,fontSize:12,color:colors.textMuted},
  card:{marginBottom:10,flexDirection:"row",alignItems:"flex-start",borderWidth:1,borderColor:colors.border,borderRadius:18,backgroundColor:colors.surface,overflow:"hidden"},workingCard:{borderColor:"#BBBDF3"},cardMain:{flex:1,minWidth:0,padding:16,paddingRight:0},moreButton:{width:48,height:52,alignItems:"center",justifyContent:"center",flexShrink:0},cardMeta:{flexDirection:"row",alignItems:"center",gap:6,marginBottom:9},project:{maxWidth:"55%",marginRight:4,fontSize:11,color:colors.textMuted},statusDot:{width:6,height:6,borderRadius:3,backgroundColor:colors.textSoft},statusDotLive:{backgroundColor:colors.success},status:{fontSize:11,color:colors.textMuted},statusLive:{color:colors.success},cardTitle:{fontSize:17,lineHeight:23,fontWeight:"600",letterSpacing:-.2,color:colors.text},preview:{marginTop:8,fontSize:13,lineHeight:20,color:colors.textMuted},
  empty:{flex:1,minHeight:220,alignItems:"center",justifyContent:"center",padding:24},emptyTitle:{marginTop:16,fontSize:17,fontWeight:"700",color:colors.text},emptyText:{marginTop:7,fontSize:13,lineHeight:20,textAlign:"center",color:colors.textMuted},emptyAction:{minHeight:48,justifyContent:"center",paddingHorizontal:20,marginTop:16,borderRadius:14,backgroundColor:colors.ink},emptyActionText:{color:"white",fontSize:14,fontWeight:"600"},
});

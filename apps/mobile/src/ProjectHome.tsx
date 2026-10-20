import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors } from "./theme";
import { MobileIcon } from "./MobileIcon";
import { MobileActionSheet } from "./MobileActionSheet";

interface ProjectChoice { key: string; label: string; cwd: string; count: number; }
export function ProjectHome({ projects, totalCount, loading, refreshing, connected, lastProject, onOpen, onArchive, onCreate, onRefresh, usage }: {
  projects: ProjectChoice[];
  totalCount: number;
  loading: boolean;
  refreshing: boolean;
  connected: boolean;
  lastProject: string;
  onOpen: (key: string) => void;
  onArchive: (project: ProjectChoice) => void;
  onCreate: () => void;
  onRefresh: () => void;
  usage: { used: number | null; resetsAt: number | null };
}) {
  const [query,setQuery]=useState("");
  const [actions,setActions]=useState<ProjectChoice|null>(null);
  const visible=projects.filter(project=>`${project.label} ${project.cwd}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const last=projects.find(project=>project.key===lastProject);
  return <View style={styles.page}>
    <View style={styles.header}>
      <View style={styles.heading}><Text style={styles.title}>Projects</Text><View style={styles.connection}><View style={[styles.dot,{backgroundColor:connected?colors.success:colors.warning}]}/><Text style={styles.connectionText}>{connected?"Connected to your PC":"Reconnecting…"}</Text></View></View>
      <Pressable style={styles.create} onPress={onCreate} disabled={loading} accessibilityRole="button" accessibilityLabel="Create project"><MobileIcon name="plus" size={24} color="white"/></Pressable>
    </View>
    <View style={styles.search}><MobileIcon name="search" color={colors.textMuted}/><TextInput style={styles.input} placeholder="Find a project" value={query} onChangeText={setQuery} placeholderTextColor={colors.textSoft}/>{query?<Pressable style={styles.clear} onPress={()=>setQuery("")} accessibilityRole="button" accessibilityLabel="Clear search"><MobileIcon name="x-circle" color={colors.textMuted}/></Pressable>:null}</View>
    <FlatList data={visible} keyExtractor={item=>item.key} style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" refreshing={refreshing} onRefresh={onRefresh}
      ListHeaderComponent={!query&&last?<Pressable style={styles.resume} onPress={()=>onOpen(last.key)} accessibilityRole="button"><View style={styles.resumeCopy}><Text style={styles.resumeLabel}>LAST WORKSPACE</Text><Text style={styles.resumeTitle} numberOfLines={1}>{last.label}</Text></View><Text style={styles.resumeAction}>Continue</Text><MobileIcon name="arrow-right" size={18} color={colors.primary}/></Pressable>:null}
      ListEmptyComponent={<View style={styles.empty}>{loading?<ActivityIndicator color={colors.primary}/>:<MobileIcon name="folder" size={34} color={colors.textSoft}/>}<Text style={styles.emptyTitle}>{loading?"Loading projects…":query?"No matching projects":"Your workspace starts here"}</Text><Text style={styles.emptyText}>{query?"Try a different name or folder.":"Add a working folder to organize its conversations."}</Text>{!loading&&!query&&<Pressable style={styles.emptyButton} onPress={onCreate}><Text style={styles.emptyButtonText}>Create project</Text></Pressable>}</View>}
      renderItem={({item})=><View style={styles.project}>
        <Pressable style={styles.projectMain} onPress={()=>onOpen(item.key)} accessibilityRole="button" accessibilityLabel={`Open ${item.label}`}>
          <View style={styles.projectIcon}><MobileIcon name="folder" size={23} color={colors.primary}/></View>
          <View style={styles.projectCopy}><Text style={styles.projectName} numberOfLines={1}>{item.label}</Text><Text style={styles.projectMeta}>{item.count} active {item.count===1?"task":"tasks"}</Text><Text style={styles.path} numberOfLines={1} ellipsizeMode="middle">{item.cwd}</Text></View>
        </Pressable>
        <Pressable style={styles.projectAction} onPress={()=>setActions(item)} accessibilityRole="button" accessibilityLabel={`Actions for ${item.label}`}><MobileIcon name="more-horizontal" color={colors.textMuted}/></Pressable>
      </View>}
      ListFooterComponent={!loading?<View style={styles.footer}><Pressable style={styles.overview} onPress={()=>onOpen("__all_projects__")} accessibilityRole="button"><MobileIcon name="grid" color={colors.textMuted}/><View style={styles.projectCopy}><Text style={styles.overviewTitle}>All projects</Text><Text style={styles.projectMeta}>{totalCount} tasks in the complete overview</Text></View><MobileIcon name="chevron-right" color={colors.textMuted} size={18}/></Pressable>{usage.used!==null&&<Text style={styles.usage}>{usage.used}% usage{usage.resetsAt?` · resets ${new Date(usage.resetsAt*1000).toLocaleString()}`:""}</Text>}</View>:null}/>
    {actions&&<MobileActionSheet title={actions.label} onClose={()=>setActions(null)} actions={[
      {label:"Open project",icon:"folder",onPress:()=>onOpen(actions.key)},
      {label:`Archive ${actions.count} conversations`,icon:"archive",destructive:true,onPress:()=>onArchive(actions)},
    ]}/>}
  </View>;
}

const styles=StyleSheet.create({
  page:{flex:1,backgroundColor:colors.background},header:{minHeight:100,paddingHorizontal:20,paddingVertical:20,flexDirection:"row",alignItems:"center",gap:12},heading:{flex:1,minWidth:0},title:{fontSize:30,fontWeight:"700",letterSpacing:-1,color:colors.text},connection:{marginTop:7,flexDirection:"row",alignItems:"center",gap:6},dot:{width:7,height:7,borderRadius:4},connectionText:{fontSize:12,color:colors.textMuted},create:{width:48,height:48,alignItems:"center",justifyContent:"center",borderRadius:15,backgroundColor:colors.ink},
  search:{marginHorizontal:16,marginBottom:16,minHeight:48,paddingLeft:14,flexDirection:"row",alignItems:"center",gap:10,borderWidth:1,borderColor:colors.border,borderRadius:14,backgroundColor:colors.surface},input:{flex:1,minWidth:0,paddingVertical:12,paddingRight:12,fontSize:14,color:colors.text},clear:{width:44,height:44,alignItems:"center",justifyContent:"center"},
  list:{flex:1},listContent:{paddingHorizontal:16,paddingBottom:20},resume:{minHeight:84,marginBottom:20,padding:16,flexDirection:"row",alignItems:"center",gap:10,borderRadius:18,backgroundColor:colors.primarySoft},resumeCopy:{flex:1,minWidth:0},resumeLabel:{fontSize:10,fontWeight:"700",letterSpacing:.8,color:colors.primary},resumeTitle:{marginTop:6,fontSize:16,fontWeight:"600",color:colors.text},resumeAction:{fontSize:13,fontWeight:"600",color:colors.primary},
  project:{minHeight:98,marginBottom:10,flexDirection:"row",alignItems:"center",borderWidth:1,borderColor:colors.border,borderRadius:18,backgroundColor:colors.surface},projectMain:{flex:1,minWidth:0,padding:16,paddingRight:0,flexDirection:"row",alignItems:"center",gap:13},projectIcon:{width:44,height:44,alignItems:"center",justifyContent:"center",borderRadius:13,backgroundColor:colors.primarySoft},projectCopy:{flex:1,minWidth:0},projectName:{fontSize:17,fontWeight:"600",color:colors.text},projectMeta:{marginTop:5,fontSize:12,color:colors.textMuted},path:{marginTop:5,fontSize:10,color:colors.textSoft},projectAction:{width:48,height:56,alignItems:"center",justifyContent:"center"},
  footer:{marginTop:12},overview:{minHeight:76,padding:14,flexDirection:"row",alignItems:"center",gap:13,borderRadius:16,borderWidth:1,borderColor:colors.border},overviewTitle:{fontSize:14,fontWeight:"600",color:colors.text},usage:{marginTop:16,fontSize:11,lineHeight:17,textAlign:"center",color:colors.textMuted},
  empty:{minHeight:220,padding:24,alignItems:"center",justifyContent:"center"},emptyTitle:{marginTop:16,fontSize:17,fontWeight:"700",color:colors.text},emptyText:{marginTop:8,fontSize:13,lineHeight:20,textAlign:"center",color:colors.textMuted},emptyButton:{marginTop:16,minHeight:48,paddingHorizontal:20,justifyContent:"center",borderRadius:14,backgroundColor:colors.ink},emptyButtonText:{color:"white",fontSize:14,fontWeight:"600"},
});

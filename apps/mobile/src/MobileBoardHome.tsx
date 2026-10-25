import { useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import type { ProjectCustomer, QueuedMessage, ThreadDto } from "@codex-board/protocol";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "./theme";
import { MobileIcon } from "./MobileIcon";
import { MobileActionSheet } from "./MobileActionSheet";

export interface MobileCategory { name: string; count: number; }
interface MobileBoardHomeProps {
  connected: boolean;
  loading: boolean;
  refreshing: boolean;
  projectLabel: string;
  customerId: string | null;
  customers: ProjectCustomer[];
  customerThreadCount: number;
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
  onCustomer: (customerId: string | null) => void;
  onDeleteCustomer: (customer: ProjectCustomer) => void;
  onCreateCustomer: () => void;
  onAssignCustomer: (thread: ThreadDto) => void;
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
  const insets = useSafeAreaInsets();
  const [actionThread, setActionThread] = useState<ThreadDto | null>(null);
  const [customerPickerOpen, setCustomerPickerOpen] = useState(false);
  const deferredPickerAction = useRef<(() => void) | null>(null);
  const selectedCustomer = props.customers.find(customer => customer.id === props.customerId);
  function chooseCustomer(action: () => void) {
    if (Platform.OS === "ios") {
      deferredPickerAction.current = action;
      setCustomerPickerOpen(false);
    } else {
      setCustomerPickerOpen(false);
      action();
    }
  }
  return <View style={styles.page}>
    <View style={[styles.header,compact&&styles.compactHeader]}>
      <Pressable style={styles.iconButton} onPress={props.onBackToProjects} accessibilityRole="button" accessibilityLabel="Back to projects"><MobileIcon name="chevron-left" size={25} color={colors.text}/></Pressable>
      <View style={styles.heading}><Text style={styles.title} numberOfLines={1}>{props.projectLabel}</Text><Text style={styles.subtitle}>{props.totalCount} tasks{props.workingCount?` · ${props.workingCount} working`:""}{!props.connected?" · Reconnecting…":""}</Text></View>
      <Pressable style={[styles.iconButton,styles.newButton]} onPress={props.onNewTask} accessibilityRole="button" accessibilityLabel="New task"><MobileIcon name="plus" size={24} color="white"/></Pressable>
    </View>
    {!props.showProject&&<Pressable style={styles.customerPickerButton} onPress={()=>setCustomerPickerOpen(true)} accessibilityRole="button" accessibilityLabel={`Choose customer board, currently ${selectedCustomer?.name||"Project threads"}`}>
      <View style={styles.customerPickerIcon}><MobileIcon name={selectedCustomer?"users":"folder"} size={17} color={colors.primary}/></View>
      <View style={styles.customerPickerCopy}><Text style={styles.customerPickerLabel}>{selectedCustomer?"CUSTOMER":"PROJECT BOARD"}</Text><Text numberOfLines={1} style={styles.customerPickerValue}>{selectedCustomer?.name||"Project threads"}</Text></View>
      <Text style={styles.customerPickerCount}>{props.totalCount}</Text><MobileIcon name="chevron-down" size={18} color={colors.textMuted}/>
    </Pressable>}
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
      {label:"Assign to customer",icon:"users",onPress:()=>props.onAssignCustomer(actionThread)},
      {label:"Fork conversation",icon:"git-branch",onPress:()=>props.onFork(actionThread)},
      ...(props.isWorking(actionThread)?[{label:"Stop Codex",icon:"stop-circle" as const,onPress:()=>props.onStop(actionThread)}]:[]),
      {label:"Archive conversation",icon:"archive",destructive:true,onPress:()=>props.onArchive(actionThread)},
    ]}/>}
    {!props.showProject&&<Modal visible={customerPickerOpen} transparent animationType="fade" onRequestClose={()=>setCustomerPickerOpen(false)} onDismiss={()=>{
      const action=deferredPickerAction.current;
      if(action){deferredPickerAction.current=null;action();}
    }}>
      <View style={styles.customerPickerBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={()=>setCustomerPickerOpen(false)} accessibilityRole="button" accessibilityLabel="Close customer selector"/>
        <View accessibilityViewIsModal style={[styles.customerPickerSheet,{paddingBottom:Math.max(insets.bottom,20)}]}>
          <View style={styles.customerPickerHeading}><View style={styles.customerPickerHeadingCopy}><Text style={styles.customerPickerTitle}>Project boards</Text><Text style={styles.customerPickerSubtitle}>{props.projectLabel}</Text></View><Pressable style={styles.pickerClose} onPress={()=>setCustomerPickerOpen(false)} accessibilityRole="button" accessibilityLabel="Close"><MobileIcon name="x" size={22} color={colors.text}/></Pressable></View>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Pressable style={[styles.customerPickerRow, !selectedCustomer&&styles.customerPickerRowSelected]} onPress={()=>chooseCustomer(()=>props.onCustomer(null))} accessibilityRole="button" accessibilityState={{selected:!selectedCustomer}}>
              <View style={[styles.customerRowIcon,!selectedCustomer&&styles.customerRowIconSelected]}><MobileIcon name="folder" size={18} color={!selectedCustomer?"white":colors.textMuted}/></View><View style={styles.customerRowCopy}><Text style={styles.customerRowName}>Project threads</Text><Text style={styles.customerRowMeta}>Shared conversations for this project</Text></View><Text style={styles.customerRowCount}>{props.customerThreadCount}</Text>{!selectedCustomer&&<MobileIcon name="check" size={19} color={colors.primary}/>}
            </Pressable>
            {props.customers.length>0&&<Text style={styles.customerListLabel}>CUSTOMERS</Text>}
            {props.customers.map(customer=>{const active=customer.id===props.customerId;return <View key={customer.id} style={[styles.customerPickerRow,active&&styles.customerPickerRowSelected]}>
              <Pressable style={styles.customerRowMain} onPress={()=>chooseCustomer(()=>props.onCustomer(customer.id))} accessibilityRole="button" accessibilityState={{selected:active}}>
                <View style={[styles.customerRowIcon,active&&styles.customerRowIconSelected]}><MobileIcon name="users" size={18} color={active?"white":colors.textMuted}/></View><View style={styles.customerRowCopy}><Text numberOfLines={1} style={styles.customerRowName}>{customer.name}</Text><Text style={styles.customerRowMeta}>Customer conversations</Text></View><Text style={styles.customerRowCount}>{customer.threadIds.length}</Text>{active&&<MobileIcon name="check" size={19} color={colors.primary}/>}
              </Pressable>
              <Pressable style={styles.customerDelete} onPress={()=>chooseCustomer(()=>props.onDeleteCustomer(customer))} accessibilityRole="button" accessibilityLabel={`Delete customer ${customer.name}`}><MobileIcon name="trash-2" size={17} color={colors.textSoft}/></Pressable>
            </View>;})}
            <Pressable style={styles.customerAddRow} onPress={()=>chooseCustomer(props.onCreateCustomer)} accessibilityRole="button"><View style={styles.customerAddIcon}><MobileIcon name="plus" size={19} color={colors.primary}/></View><Text style={styles.customerAddLabel}>Add customer</Text></Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>}
  </View>;
}

const styles=StyleSheet.create({
  page:{flex:1,backgroundColor:colors.background},header:{minHeight:84,paddingHorizontal:12,paddingVertical:12,flexDirection:"row",alignItems:"center",gap:10,backgroundColor:colors.surface},
  compactHeader:{minHeight:60,paddingVertical:6},compactSearch:{marginTop:8,marginBottom:4,minHeight:44},
  iconButton:{width:48,height:48,flexShrink:0,alignItems:"center",justifyContent:"center",borderRadius:15},newButton:{backgroundColor:colors.ink},heading:{flex:1,minWidth:0},title:{fontSize:21,fontWeight:"700",letterSpacing:-.5,color:colors.text},subtitle:{marginTop:5,fontSize:12,color:colors.textMuted},
  search:{margin:16,marginBottom:8,minHeight:48,paddingLeft:14,flexDirection:"row",alignItems:"center",gap:10,borderWidth:1,borderColor:colors.border,borderRadius:14,backgroundColor:colors.surface},searchInput:{flex:1,minWidth:0,paddingVertical:12,paddingRight:8,color:colors.text,fontSize:14},clearSearch:{width:44,height:44,alignItems:"center",justifyContent:"center"},
  customerPickerButton:{minHeight:60,marginHorizontal:16,marginTop:4,marginBottom:4,paddingHorizontal:12,flexDirection:"row",alignItems:"center",gap:10,borderWidth:1,borderColor:colors.border,borderRadius:15,backgroundColor:colors.surface},customerPickerIcon:{width:34,height:34,alignItems:"center",justifyContent:"center",borderRadius:11,backgroundColor:colors.primarySoft},customerPickerCopy:{flex:1,minWidth:0},customerPickerLabel:{fontSize:9,fontWeight:"800",letterSpacing:.8,color:colors.textSoft},customerPickerValue:{marginTop:3,fontSize:13,fontWeight:"700",color:colors.text},customerPickerCount:{minWidth:26,textAlign:"right",fontSize:12,fontWeight:"700",color:colors.textMuted},customerPickerBackdrop:{flex:1,justifyContent:"flex-end",backgroundColor:"rgba(18,20,28,.42)"},customerPickerSheet:{maxHeight:"82%",paddingHorizontal:18,paddingBottom:24,borderTopLeftRadius:24,borderTopRightRadius:24,backgroundColor:colors.surface},customerPickerHeading:{minHeight:76,flexDirection:"row",alignItems:"center",gap:12,borderBottomWidth:StyleSheet.hairlineWidth,borderColor:colors.border,marginBottom:8},customerPickerHeadingCopy:{flex:1,minWidth:0},customerPickerTitle:{fontSize:18,fontWeight:"700",color:colors.text},customerPickerSubtitle:{marginTop:4,fontSize:12,color:colors.textMuted},pickerClose:{width:44,height:44,alignItems:"center",justifyContent:"center"},customerPickerRow:{minHeight:68,marginVertical:3,paddingHorizontal:10,flexDirection:"row",alignItems:"center",gap:10,borderRadius:14},customerPickerRowSelected:{backgroundColor:colors.primarySoft},customerRowMain:{flex:1,minWidth:0,minHeight:64,flexDirection:"row",alignItems:"center",gap:10},customerRowIcon:{width:38,height:38,flexShrink:0,alignItems:"center",justifyContent:"center",borderRadius:12,backgroundColor:colors.surfaceMuted},customerRowIconSelected:{backgroundColor:colors.primary},customerRowCopy:{flex:1,minWidth:0},customerRowName:{fontSize:14,fontWeight:"600",color:colors.text},customerRowMeta:{marginTop:4,fontSize:11,color:colors.textMuted},customerRowCount:{minWidth:20,textAlign:"right",fontSize:12,color:colors.textMuted},customerListLabel:{marginTop:14,marginBottom:5,paddingHorizontal:10,fontSize:9,fontWeight:"800",letterSpacing:.9,color:colors.textSoft},customerDelete:{width:42,height:42,alignItems:"center",justifyContent:"center",borderRadius:12},customerAddRow:{minHeight:58,marginTop:8,paddingHorizontal:10,flexDirection:"row",alignItems:"center",gap:12,borderTopWidth:StyleSheet.hairlineWidth,borderColor:colors.border},customerAddIcon:{width:38,height:38,alignItems:"center",justifyContent:"center",borderRadius:12,backgroundColor:colors.primarySoft},customerAddLabel:{fontSize:14,fontWeight:"600",color:colors.primary},
  categoryScroll:{flexGrow:0,flexShrink:0,maxHeight:64},categories:{paddingHorizontal:16,paddingVertical:8,gap:8},category:{minHeight:44,paddingHorizontal:14,flexDirection:"row",alignItems:"center",gap:9,borderRadius:14,backgroundColor:colors.surface},categoryActive:{backgroundColor:colors.ink},categoryText:{fontSize:13,fontWeight:"600",color:colors.textMuted},categoryTextActive:{color:"white"},categoryCount:{fontSize:12,color:colors.textSoft},
  list:{flex:1},listContent:{padding:16,paddingTop:8,paddingBottom:24,flexGrow:1},results:{marginBottom:14,fontSize:12,color:colors.textMuted},
  card:{marginBottom:10,flexDirection:"row",alignItems:"flex-start",borderWidth:1,borderColor:colors.border,borderRadius:18,backgroundColor:colors.surface,overflow:"hidden"},workingCard:{borderColor:"#BBBDF3"},cardMain:{flex:1,minWidth:0,padding:16,paddingRight:0},moreButton:{width:48,height:52,alignItems:"center",justifyContent:"center",flexShrink:0},cardMeta:{flexDirection:"row",alignItems:"center",gap:6,marginBottom:9},project:{maxWidth:"55%",marginRight:4,fontSize:11,color:colors.textMuted},statusDot:{width:6,height:6,borderRadius:3,backgroundColor:colors.textSoft},statusDotLive:{backgroundColor:colors.success},status:{fontSize:11,color:colors.textMuted},statusLive:{color:colors.success},cardTitle:{fontSize:17,lineHeight:23,fontWeight:"600",letterSpacing:-.2,color:colors.text},preview:{marginTop:8,fontSize:13,lineHeight:20,color:colors.textMuted},
  empty:{flex:1,minHeight:220,alignItems:"center",justifyContent:"center",padding:24},emptyTitle:{marginTop:16,fontSize:17,fontWeight:"700",color:colors.text},emptyText:{marginTop:7,fontSize:13,lineHeight:20,textAlign:"center",color:colors.textMuted},emptyAction:{minHeight:48,justifyContent:"center",paddingHorizontal:20,marginTop:16,borderRadius:14,backgroundColor:colors.ink},emptyActionText:{color:"white",fontSize:14,fontWeight:"600"},
});

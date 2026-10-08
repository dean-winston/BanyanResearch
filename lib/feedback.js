const feedbackValues=['new','useful','irrelevant','known','later'];
const reasonValues=['','depth','duplicate','evidence','topic','source'];

export function applyRecommendationFeedback(store,id,input) {
  if(!feedbackValues.includes(input.feedback)||input.feedbackReason!==undefined&&!reasonValues.includes(input.feedbackReason))throw Object.assign(new Error('反馈类型或原因无效'),{status:400});
  const recommendation=store.recommendations.find(item=>item.id===id);
  if(!recommendation)throw Object.assign(new Error('推荐不存在'),{status:404});
  recommendation.feedback=input.feedback;
  recommendation.feedbackReason=input.feedback==='new'?'':input.feedbackReason??'';
  recommendation.feedbackAt=new Date().toISOString();
  return recommendation;
}

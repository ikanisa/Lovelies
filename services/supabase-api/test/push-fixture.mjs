import { createHash } from 'node:crypto';

/** Synthetic gateway receipt binding for consumer tests. Matches the production
 * gateway's canonical parseDispatch order; never contacts APNs/FCM. */
export function pushBinding(input) {
    const value={operation_key:input.operation_key,platform:input.platform,token:input.token,
        notification:{id:input.notification.id,title:input.notification.title,kind:input.notification.kind,entity_id:input.notification.entity_id}};
    return {protocol:'lovelies-push-dispatch-receipt-v1',request_sha256:createHash('sha256').update(JSON.stringify(value)).digest('hex'),platform:value.platform,notification_id:value.notification.id};
}
export function qualifiedPushFixture(provider) {
    const bindings=new Map();
    return async request=>{
        if(request.method==='POST'){
            const input=await request.clone().json();bindings.set(input.operation_key,pushBinding(input));
        }
        const value=await provider(request);
        if(value instanceof Response){
            // Deliberately malformed/streaming/redirect Responses stay untouched.
            if(value.redirected||value.status>=300&&value.status<400)return value;
            let result;try{result=await value.clone().json();}catch{return value;}
            const binding=bindings.get(result.operation_key);
            if(!binding||result.status==='unknown')return value;
            return Response.json({...binding,...result},{status:value.status,headers:value.headers});
        }
        const binding=bindings.get(value.operation_key);
        return binding&&value.status!=='unknown'?{...binding,...value}:value;
    };
}

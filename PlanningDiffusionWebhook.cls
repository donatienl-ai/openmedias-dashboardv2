public class PlanningDiffusionWebhook {
  @InvocableMethod(label='Envoyer au Planning Diffusion')
  public static void send(List<Id> opportunityIds) {
    for (Id oppId : opportunityIds) {
      sendWebhook(oppId);
    }
  }
  // Mapping des valeurs picklist SF (M_dia__c) vers les noms de médias attendus par le planning
  private static Map<String, String> MEDIA_MAP = new Map<String, String>{
    'TIME IMMERSION' => 'TIME',
    'TIME PRINT' => 'TIME',
    'TIME ARTICLE' => 'TIME',
    'BFMTV ÉMISSION' => 'BFMTV',
    'BFMTV IMMERSION / BFMBUSINESS TV' => 'BFMTV',
    'BFM BUSINESS 1&2' => 'BFM Business 1&2',
    'BFM BUSINESS 3&4' => 'BFM Business 3&4',
    'BFM BUSINESS TV' => 'BFM Business 1&2',
    'BFM BUSINESS ARTICLE' => 'BFM Business 1&2',
    'BFM BUSINESS PLATEAU TV' => 'BFM Business 1&2',
    'LE FIGARO' => 'Le Figaro HP + HP Eco',
    'CAPITAL' => 'Capital',
    'CHALLENGES' => 'Challenges'
  };
  private static String resolveMedia(String rawMedia) {
    if (rawMedia == null) return null;
    if (MEDIA_MAP.containsKey(rawMedia)) return MEDIA_MAP.get(rawMedia);
    return 'Médias spécialisés';
  }
  @future(callout=true)
  public static void sendWebhook(Id oppId) {
    Opportunity opp = [
      SELECT Id, Account.Name, Secteur_diffusion__c, Format__c, M_dia__c,
             Date_de_diffusion__c, Owner.FirstName, Homepage_Figaro__c,
             Homepage_Economie_Figaro__c, Amount
      FROM Opportunity WHERE Id = :oppId LIMIT 1
    ];
    String body = JSON.serialize(new Map<String, Object>{
      'sf_opportunity_id' => opp.Id,
      'entreprise'        => opp.Account.Name,
      'secteur'           => opp.Secteur_diffusion__c,
      'format'            => opp.Format__c,
      'media'             => resolveMedia(opp.M_dia__c),
      'date_diffusion'    => String.valueOf(opp.Date_de_diffusion__c),
      'commercial'        => opp.Owner.FirstName,
      'homepage'          => opp.Homepage_Figaro__c,
      'homepage_eco'      => opp.Homepage_Economie_Figaro__c,
      'montant'           => opp.Amount
    });
    HttpRequest req = new HttpRequest();
    req.setEndpoint('https://openmedias-sales-dashboard.onrender.com/planning/api/webhook/salesforce');
    req.setMethod('POST');
    req.setHeader('Content-Type', 'application/json');
    req.setHeader('x-sf-secret', 'PLACEHOLDER_SECRET');
    req.setBody(body);
    req.setTimeout(10000);
    new Http().send(req);
  }
}

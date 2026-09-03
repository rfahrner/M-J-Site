Option Explicit

' Classic Outlook only. New Outlook for Windows does not support VBA.
'
' Every site fallback addressed to @textbetter.com must send through memPPW.
' Outlook may populate mailto: recipients after the compose inspector opens,
' so this module checks at open, activation, recipient-property change, and
' send time. The extra property-change check prevents a timing miss where a
' draft initially appears under another Outlook account.

Private WithEvents TextBetterInspectors As Outlook.Inspectors
Private WithEvents PendingTextBetterInspector As Outlook.Inspector
Private WithEvents PendingTextBetterMail As Outlook.MailItem
Private Const TARGET_ACCOUNT As String = "memPPW@dltransport.com"
Private Const TEXTBETTER_DOMAIN As String = "@textbetter.com"

Private Sub Application_Startup()
    Set TextBetterInspectors = Application.Inspectors
End Sub

Private Sub TextBetterInspectors_NewInspector(ByVal Inspector As Outlook.Inspector)
    On Error GoTo SafeExit

    ' Keep the newest compose inspector and mail item long enough to catch
    ' mailto: recipients that Outlook finishes populating asynchronously.
    Set PendingTextBetterInspector = Inspector
    If TypeOf Inspector.CurrentItem Is Outlook.MailItem Then
        Set PendingTextBetterMail = Inspector.CurrentItem
    End If
    TryRouteTextBetterInspector Inspector

SafeExit:
End Sub

Private Sub PendingTextBetterInspector_Activate()
    On Error GoTo SafeExit

    If PendingTextBetterInspector Is Nothing Then Exit Sub
    TryRouteTextBetterInspector PendingTextBetterInspector

SafeExit:
End Sub

Private Sub PendingTextBetterMail_PropertyChange(ByVal Name As String)
    On Error GoTo SafeExit

    If PendingTextBetterMail Is Nothing Then Exit Sub

    ' The To property is the key event for drafts created from the site's
    ' mailto: links. Check every built-in property change as a harmless
    ' fallback because Outlook versions can report recipient changes
    ' differently.
    TryRouteTextBetterMail PendingTextBetterMail

SafeExit:
End Sub

Private Sub Application_ItemSend(ByVal Item As Object, Cancel As Boolean)
    On Error GoTo SafeExit

    If Not TypeOf Item Is Outlook.MailItem Then Exit Sub

    Dim mail As Outlook.MailItem
    Set mail = Item

    If IsTextBetterMail(mail) Then
        SetTextBetterSendAccount mail
    End If

SafeExit:
End Sub

Private Sub TryRouteTextBetterInspector(ByVal Inspector As Outlook.Inspector)
    On Error GoTo SafeExit

    If Not TypeOf Inspector.CurrentItem Is Outlook.MailItem Then Exit Sub

    Dim mail As Outlook.MailItem
    Set mail = Inspector.CurrentItem
    TryRouteTextBetterMail mail

SafeExit:
End Sub

Private Sub TryRouteTextBetterMail(ByVal mail As Outlook.MailItem)
    On Error GoTo SafeExit

    If IsTextBetterMail(mail) Then
        ' Stop listening before changing SendUsingAccount; some Outlook builds
        ' raise another property event for that assignment.
        Set PendingTextBetterMail = Nothing
        Set PendingTextBetterInspector = Nothing
        SetTextBetterSendAccount mail
    End If

SafeExit:
End Sub

Private Function IsTextBetterMail(ByVal mail As Outlook.MailItem) As Boolean
    On Error GoTo SafeExit

    If InStr(1, mail.To, TEXTBETTER_DOMAIN, vbTextCompare) > 0 Then
        IsTextBetterMail = True
        Exit Function
    End If

    Dim recipient As Outlook.Recipient
    For Each recipient In mail.Recipients
        If InStr(1, recipient.Address, TEXTBETTER_DOMAIN, vbTextCompare) > 0 _
           Or InStr(1, recipient.Name, TEXTBETTER_DOMAIN, vbTextCompare) > 0 Then
            IsTextBetterMail = True
            Exit Function
        End If
    Next recipient

SafeExit:
End Function

Private Sub SetTextBetterSendAccount(ByVal mail As Outlook.MailItem)
    On Error GoTo SafeExit

    Dim acc As Outlook.Account
    For Each acc In Application.Session.Accounts
        If StrComp(acc.SmtpAddress, TARGET_ACCOUNT, vbTextCompare) = 0 Then
            Set mail.SendUsingAccount = acc
            Exit Sub
        End If
    Next acc

SafeExit:
End Sub
